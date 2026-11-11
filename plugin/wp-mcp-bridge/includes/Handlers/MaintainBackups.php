<?php
/**
 * Part of Maintain: database backups.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\PhpGuard;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

trait MaintainBackups {

    /* ----------------------------------------------------------------- backups */

    private static function backup_dir(): string {
        $uploads = wp_upload_dir( null, false );
        $dir     = trailingslashit( $uploads['basedir'] ) . 'wpmcp-backups';
        if ( ! is_dir( $dir ) ) {
            wp_mkdir_p( $dir );
            file_put_contents( $dir . '/.htaccess', "Deny from all\n<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n" );
            file_put_contents( $dir . '/index.php', "<?php\n// Silence.\n" );
        }

        return $dir;
    }

    /** @return array<int, string> */
    private static function tables(): array {
        global $wpdb;

        return array_map( 'strval', (array) $wpdb->get_col( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $wpdb->prefix ) . '%' ) ) );
    }

    /**
     * Streams every table of this site to a gzip file, one statement per line.
     *
     * @return array<string, mixed>
     */
    public static function dump_db( string $label ): array {
        global $wpdb;
        @set_time_limit( 300 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        $id   = gmdate( 'Ymd-His' ) . '-' . bin2hex( random_bytes( 4 ) );
        $file = self::backup_dir() . "/db-$id.sql.gz";
        $gz   = gzopen( $file, 'wb6' );
        if ( ! $gz ) {
            throw new BridgeError( 'backup_failed', 'Cannot write the backup file.', 500 );
        }
        gzwrite( $gz, '-- wpmcp-backup v1 prefix=' . $wpdb->prefix . "\n" );
        $tables = self::tables();
        foreach ( $tables as $table ) {
            $create = $wpdb->get_row( 'SHOW CREATE TABLE `' . esc_sql( $table ) . '`', ARRAY_N ); // phpcs:ignore WordPress.DB
            if ( ! $create ) {
                continue;
            }
            gzwrite( $gz, 'DROP TABLE IF EXISTS `' . $table . "`;\n" );
            gzwrite( $gz, str_replace( "\n", ' ', (string) $create[1] ) . ";\n" );
            $offset = 0;
            do {
                $rows = $wpdb->get_results( 'SELECT * FROM `' . esc_sql( $table ) . '` LIMIT 500 OFFSET ' . (int) $offset, ARRAY_A ); // phpcs:ignore WordPress.DB
                if ( ! $rows ) {
                    break;
                }
                $values = array();
                foreach ( $rows as $row ) {
                    $values[] = '(' . implode( ',', array_map( static fn ( $v ) => null === $v ? 'NULL' : "'" . $wpdb->_real_escape( (string) $v ) . "'", $row ) ) . ')';
                }
                gzwrite( $gz, 'INSERT INTO `' . $table . '` VALUES ' . implode( ',', $values ) . ";\n" );
                $offset += 500;
            } while ( count( $rows ) === 500 );
        }
        gzclose( $gz );
        $entry = array( 'file' => basename( $file ), 'created' => time(), 'label' => substr( sanitize_text_field( $label ), 0, 100 ), 'tables' => count( $tables ), 'bytes' => (int) filesize( $file ) );
        $all   = (array) get_option( 'wpm_backups', array() );
        $all[ $id ] = $entry;
        if ( count( $all ) > 15 ) {
            $oldest = array_key_first( $all );
            @unlink( self::backup_dir() . '/' . $all[ $oldest ]['file'] ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
            unset( $all[ $oldest ] );
        }
        update_option( 'wpm_backups', $all, false );

        return array( 'id' => $id ) + $entry;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_backup_create( array $a, Context $c ): array {
        $b          = self::dump_db( (string) ( $a['label'] ?? 'manual' ) );
        $c->summary = "database backup {$b['id']} (" . size_format( (int) $b['bytes'] ) . ')';

        return $b + array( 'note' => 'Database only. Files (uploads, themes, plugins) are not included; use your host or a file-backup plugin for those.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_backup_list( array $a, Context $c ): array {
        $out = array();
        foreach ( array_reverse( (array) get_option( 'wpm_backups', array() ), true ) as $id => $b ) {
            $out[] = array( 'id' => $id, 'label' => $b['label'], 'created' => gmdate( 'c', (int) $b['created'] ), 'size' => size_format( (int) $b['bytes'] ), 'tables' => $b['tables'], 'exists' => is_file( self::backup_dir() . '/' . $b['file'] ) );
        }

        return array( 'backups' => $out );
    }

    /** @return array<string, mixed> */
    private static function backup_entry( string $id ): array {
        $all = (array) get_option( 'wpm_backups', array() );
        if ( ! isset( $all[ $id ] ) || ! is_file( self::backup_dir() . '/' . $all[ $id ]['file'] ) ) {
            throw new BridgeError( 'not_found', 'No such backup.', 404 );
        }

        return $all[ $id ];
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_backup_restore( array $a, Context $c ): array {
        $b = self::backup_entry( (string) $a['id'] );

        return array( 'will_restore' => $a['id'], 'label' => $b['label'], 'created' => gmdate( 'c', (int) $b['created'] ), 'effect' => 'All database tables of this site are replaced by the backup. Content and settings changed since then are lost. A safety backup of the current state is taken first.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_backup_restore( array $a, Context $c ): array {
        global $wpdb;
        $b      = self::backup_entry( (string) $a['id'] );
        $safety = self::dump_db( 'safety backup before restoring ' . $a['id'] );
        @set_time_limit( 300 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        $gz = gzopen( self::backup_dir() . '/' . $b['file'], 'rb' );
        if ( ! $gz ) {
            throw new BridgeError( 'restore_failed', 'Cannot read the backup.', 500 );
        }
        $header = trim( (string) gzgets( $gz ) );
        if ( '-- wpmcp-backup v1 prefix=' . $wpdb->prefix !== $header ) {
            gzclose( $gz );
            throw new BridgeError( 'restore_failed', 'This backup belongs to a different table prefix.', 400 );
        }
        $wpdb->query( 'SET FOREIGN_KEY_CHECKS=0' );
        $ran = 0;
        while ( ! gzeof( $gz ) ) {
            $line = trim( (string) gzgets( $gz, 4194304 ) );
            if ( '' === $line ) {
                continue;
            }
            if ( ! preg_match( '/^(DROP TABLE IF EXISTS|CREATE TABLE|INSERT INTO) `' . preg_quote( $wpdb->prefix, '/' ) . '[A-Za-z0-9_$]*`/', $line ) ) {
                gzclose( $gz );
                throw new BridgeError( 'restore_failed', 'The backup contains a statement the bridge does not accept. Stopped; a safety backup was made: ' . $safety['id'], 500 );
            }
            $wpdb->query( $line ); // phpcs:ignore WordPress.DB
            ++$ran;
        }
        gzclose( $gz );
        $wpdb->query( 'SET FOREIGN_KEY_CHECKS=1' );
        wp_cache_flush();
        // Keep the registry of backups: the restored options row may predate them.
        $all = (array) get_option( 'wpm_backups', array() );
        $all[ (string) $a['id'] ]       = $b;
        $all[ (string) $safety['id'] ]  = array_diff_key( $safety, array( 'id' => 1 ) );
        update_option( 'wpm_backups', $all, false );
        $c->summary = "restored backup {$a['id']}";

        return array( 'restored' => $a['id'], 'statements' => $ran, 'safety_backup' => $safety['id'], 'note' => 'You may need to sign in again.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_backup_delete( array $a, Context $c ): array {
        $b = self::backup_entry( (string) $a['id'] );
        @unlink( self::backup_dir() . '/' . $b['file'] ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        $all = (array) get_option( 'wpm_backups', array() );
        unset( $all[ (string) $a['id'] ] );
        update_option( 'wpm_backups', $all, false );
        $c->summary = "deleted backup {$a['id']}";

        return array( 'deleted' => $a['id'] );
    }
}
