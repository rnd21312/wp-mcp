<?php
/**
 * snippets.* operations: the Code Snippets plugin (3.x) through its own functions, so its caches and checks stay in charge.
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

defined( 'ABSPATH' ) || exit;

final class Snippets {

    /** Name of a Code Snippets function (the plugin keeps them in the Code_Snippets namespace, older 3.x releases globally). */
    private static function resolve( string $name ): ?string {
        foreach ( array( 'Code_Snippets\\' . $name, $name ) as $candidate ) {
            if ( function_exists( $candidate ) ) {
                return $candidate;
            }
        }

        return null;
    }

    public static function available(): bool {
        return class_exists( '\Code_Snippets\Snippet' ) && null !== self::resolve( 'get_snippet' ) && null !== self::resolve( 'save_snippet' );
    }

    private static function need_plugin(): void {
        if ( ! self::available() ) {
            throw new BridgeError( 'plugin_missing', 'The Code Snippets plugin (3.0 or newer) is not active on this site. plugins.install / plugins.activate with code-snippets/code-snippets.php.', 409 );
        }
    }

    /** @return mixed */
    private static function call( string $name, ...$args ) {
        $fn = self::resolve( $name );
        if ( null === $fn ) {
            throw new BridgeError( 'plugin_unsupported', "This version of Code Snippets has no $name().", 409 );
        }

        return $fn( ...$args );
    }

    /** @return object */
    private static function find( int $id ) {
        self::need_plugin();
        $snippet = self::call( 'get_snippet', $id );
        if ( ! is_object( $snippet ) || (int) $snippet->id !== $id ) {
            throw new BridgeError( 'not_found', "No snippet $id.", 404 );
        }

        return $snippet;
    }

    /**
     * @param object $s Snippet.
     * @return array<string, mixed>
     */
    private static function fields( $s ): array {
        return array(
            'id'          => (int) $s->id,
            'name'        => (string) $s->name,
            'description' => (string) $s->desc,
            'code'        => (string) $s->code,
            'tags'        => array_values( (array) $s->tags ),
            'scope'       => (string) $s->scope,
            'priority'    => (int) $s->priority,
            'active'      => (bool) $s->active,
        );
    }

    /**
     * @param object               $s Snippet.
     * @param array<string, mixed> $f Fields from fields().
     */
    private static function fill( $s, array $f ): void {
        $s->name     = (string) $f['name'];
        $s->desc     = (string) $f['description'];
        $s->code     = (string) $f['code'];
        $s->tags     = (array) $f['tags'];
        $s->scope    = (string) $f['scope'];
        $s->priority = (int) $f['priority'];
        $s->active   = (bool) $f['active'];
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_list( array $a, Context $c ): array {
        self::need_plugin();
        $search = strtolower( trim( (string) ( $a['search'] ?? '' ) ) );
        $tag    = trim( (string) ( $a['tag'] ?? '' ) );
        $rows   = array();
        foreach ( (array) self::call( 'get_snippets' ) as $s ) {
            $f = self::fields( $s );
            if ( isset( $a['active'] ) && (bool) $a['active'] !== $f['active'] ) {
                continue;
            }
            if ( ! empty( $a['scope'] ) && (string) $a['scope'] !== $f['scope'] ) {
                continue;
            }
            if ( '' !== $tag && ! in_array( $tag, $f['tags'], true ) ) {
                continue;
            }
            if ( '' !== $search && ! str_contains( strtolower( $f['name'] . ' ' . $f['description'] . ' ' . implode( ' ', $f['tags'] ) ), $search ) ) {
                continue;
            }
            unset( $f['code'] );
            $f['modified'] = (string) ( $s->modified ?? '' );
            $rows[]        = $f;
        }
        $per_page = max( 1, min( 100, (int) ( $a['per_page'] ?? 50 ) ) );
        $page     = max( 1, (int) ( $a['page'] ?? 1 ) );

        return array( 'total' => count( $rows ), 'page' => $page, 'snippets' => array_slice( $rows, ( $page - 1 ) * $per_page, $per_page ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_get( array $a, Context $c ): array {
        $s = self::find( (int) $a['id'] );

        return self::fields( $s ) + array( 'modified' => (string) ( $s->modified ?? '' ) );
    }

    /**
     * The fields a save would leave behind: the stored snippet (if any) with the new values on top, checked.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array{0: array<string, mixed>, 1: array<string, mixed>|null, 2: object|null}
     */
    private static function plan( array $a ): array {
        self::need_plugin();
        $id     = (int) ( $a['id'] ?? 0 );
        $stored = $id ? self::find( $id ) : null;
        $old    = $stored ? self::fields( $stored ) : null;
        $new    = $old ?? array( 'id' => 0, 'name' => '', 'description' => '', 'code' => '', 'tags' => array(), 'scope' => 'global', 'priority' => 10, 'active' => false );
        if ( isset( $a['name'] ) ) {
            $new['name'] = trim( (string) $a['name'] );
        }
        if ( isset( $a['description'] ) ) {
            $new['description'] = (string) $a['description'];
        }
        if ( isset( $a['code'] ) ) {
            $new['code'] = (string) $a['code'];
        }
        if ( isset( $a['tags'] ) ) {
            $new['tags'] = Policy::snippet_tags( $a['tags'] );
        }
        if ( isset( $a['priority'] ) ) {
            $new['priority'] = (int) $a['priority'];
        }
        if ( isset( $a['active'] ) ) {
            $new['active'] = (bool) $a['active'];
        }
        $new['scope'] = Policy::snippet_scope( isset( $a['scope'] ) ? (string) $a['scope'] : null, (string) $new['scope'] );
        if ( '' === $new['name'] || '' === trim( (string) $new['code'] ) ) {
            throw new BridgeError( 'bad_arguments', 'A snippet needs a name and code.', 400 );
        }
        if ( Policy::snippet_scope_is_php( $new['scope'] ) ) {
            $new['code'] = Policy::snippet_code( (string) $new['code'] );
            $problem     = PhpGuard::fragment_problem( (string) $new['code'] );
            if ( null !== $problem ) {
                throw new BridgeError( 'syntax_error', $problem . ' Nothing was saved.', 400 );
            }
        }

        return array( $new, $old, $stored );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_save( array $a, Context $c ): array {
        [ $new, $old ] = self::plan( $a );
        $changes_code  = ! $old || trim( $old['code'] ) !== trim( $new['code'] ) || $old['scope'] !== $new['scope'];
        $goes_live     = $new['active'] && ( ! $old || ! $old['active'] || $changes_code );

        return array(
            'will_save'          => array_diff_key( $new, array( 'code' => 1 ) ) + array( 'code_bytes' => strlen( (string) $new['code'] ) ),
            'creates'            => ! $old,
            'syntax'             => 'ok',
            'runs_on_the_site'   => $goes_live,
            'needs_confirmation' => $goes_live,
            'warning'            => $goes_live ? 'This code runs on every matching request of the site as soon as it is saved. It is syntax-checked, the front page is probed afterwards, and the change is reverted if the site breaks.' : null,
        );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_save( array $a, Context $c ): array {
        [ $new, $old, $stored ] = self::plan( $a );
        $goes_live              = $new['active'] && Policy::snippet_scope_is_php( $new['scope'] );
        $healthy                = $goes_live ? PhpGuard::front_ok() : null;
        $target                 = $stored ?? new \Code_Snippets\Snippet();
        self::fill( $target, $new );
        $id = self::call( 'save_snippet', $target );
        $id = is_object( $id ) ? (int) $id->id : (int) $id;
        if ( $id <= 0 ) {
            throw new BridgeError( 'save_failed', 'Code Snippets did not save the snippet.', 500 );
        }
        if ( true === $healthy && false === PhpGuard::front_ok() ) {
            self::put_back( $id, $old );
            throw new BridgeError( 'broke_site', 'The site returned a server error after this change, so it was reverted automatically. Check maintain.logs for the PHP error.', 409 );
        }
        Revisions::record( $c, 'snippet', (string) $id, $old, array( 'active' => $new['active'] ) );
        $c->summary = ( $old ? 'updated' : 'created' ) . " snippet #$id ({$new['name']})";

        return array( 'id' => $id, 'created' => ! $old, 'active' => $new['active'], 'scope' => $new['scope'] );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_activate( array $a, Context $c ): array {
        $s = self::find( (int) $a['id'] );
        $f = self::fields( $s );

        return array( 'will_activate' => $f['name'], 'scope' => $f['scope'], 'already_active' => $f['active'], 'syntax' => Policy::snippet_scope_is_php( $f['scope'] ) ? ( PhpGuard::fragment_problem( $f['code'] ) ?? 'ok' ) : 'not php', 'warning' => 'The snippet starts running on the site. A single-use snippet runs once, now.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_activate( array $a, Context $c ): array {
        $s   = self::find( (int) $a['id'] );
        $old = self::fields( $s );
        if ( $old['active'] ) {
            return array( 'id' => $old['id'], 'active' => true, 'changed' => false );
        }
        if ( Policy::snippet_scope_is_php( $old['scope'] ) && null !== ( $problem = PhpGuard::fragment_problem( $old['code'] ) ) ) {
            throw new BridgeError( 'syntax_error', $problem . ' It was not activated.', 400 );
        }
        $healthy = Policy::snippet_scope_is_php( $old['scope'] ) ? PhpGuard::front_ok() : null;
        $result  = self::call( 'activate_snippet', $old['id'] );
        if ( is_string( $result ) ) {
            throw new BridgeError( 'activate_failed', $result, 400 );
        }
        if ( true === $healthy && false === PhpGuard::front_ok() ) {
            self::put_back( $old['id'], $old );
            throw new BridgeError( 'broke_site', 'The site returned a server error after activating it, so it was deactivated again. Check maintain.logs for the PHP error.', 409 );
        }
        Revisions::record( $c, 'snippet', (string) $old['id'], $old, array( 'active' => true ) );
        $c->summary = "activated snippet #{$old['id']} ({$old['name']})";

        return array( 'id' => $old['id'], 'active' => true, 'changed' => true );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_deactivate( array $a, Context $c ): array {
        $s   = self::find( (int) $a['id'] );
        $old = self::fields( $s );
        if ( ! $old['active'] ) {
            return array( 'id' => $old['id'], 'active' => false, 'changed' => false );
        }
        self::call( 'deactivate_snippet', $old['id'] );
        Revisions::record( $c, 'snippet', (string) $old['id'], $old, array( 'active' => false ) );
        $c->summary = "deactivated snippet #{$old['id']} ({$old['name']})";

        return array( 'id' => $old['id'], 'active' => false, 'changed' => true );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_delete( array $a, Context $c ): array {
        $f = self::fields( self::find( (int) $a['id'] ) );

        return array( 'will_delete' => $f['name'], 'scope' => $f['scope'], 'active' => $f['active'], 'code_bytes' => strlen( $f['code'] ), 'note' => 'Undo recreates it (with a new id).' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_delete( array $a, Context $c ): array {
        $old = self::fields( self::find( (int) $a['id'] ) );
        if ( ! self::call( 'delete_snippet', $old['id'] ) ) {
            throw new BridgeError( 'delete_failed', 'Code Snippets did not delete the snippet.', 500 );
        }
        Revisions::record( $c, 'snippet', (string) $old['id'], $old, array( 'deleted' => true ) );
        $c->summary = "deleted snippet #{$old['id']} ({$old['name']})";

        return array( 'id' => $old['id'], 'deleted' => true );
    }

    /**
     * Puts a snippet back to an earlier state: null removes it (it was created by the change).
     *
     * @param array<string, mixed>|null $before Fields from fields(), or null.
     */
    private static function put_back( int $id, ?array $before ): void {
        if ( null === $before ) {
            self::call( 'delete_snippet', $id );

            return;
        }
        $s = self::call( 'get_snippet', $id );
        if ( ! is_object( $s ) || (int) $s->id !== $id ) {
            $s = new \Code_Snippets\Snippet(); // it was deleted: recreate it (with a new id)
        }
        self::fill( $s, $before );
        self::call( 'save_snippet', $s );
    }

    /**
     * Undo of a snippet change.
     *
     * @param array<string, mixed>|null $before Snapshot.
     */
    public static function restore( string $target, $before ): string {
        self::need_plugin();
        $id = (int) $target;
        if ( null === $before ) {
            self::call( 'delete_snippet', $id );

            return 'The snippet that was created is deleted.';
        }
        self::put_back( $id, (array) $before );

        return 'Snippet restored to its earlier state.';
    }
}
