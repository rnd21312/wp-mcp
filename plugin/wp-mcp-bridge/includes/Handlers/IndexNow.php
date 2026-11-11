<?php
/**
 * IndexNow (Bing, Yandex and others): a key served at /<key>.txt and submission of changed URLs.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;

defined( 'ABSPATH' ) || exit;

final class IndexNow {

    private const OPTION   = 'wpm_indexnow_key';
    private const ENDPOINT = 'https://api.indexnow.org/indexnow';
    private const MAX_URLS = 500;

    /** Answers the request for the key file itself, so nothing has to be written into the web root. */
    public static function serve_key_file(): void {
        $key = (string) get_option( self::OPTION, '' );
        if ( '' === $key || ! isset( $_SERVER['REQUEST_URI'] ) ) {
            return;
        }
        $want = (string) wp_parse_url( home_url( '/' . $key . '.txt' ), PHP_URL_PATH );
        $got  = (string) wp_parse_url( (string) wp_unslash( $_SERVER['REQUEST_URI'] ), PHP_URL_PATH ); // phpcs:ignore WordPress.Security
        if ( $got !== $want ) {
            return;
        }
        status_header( 200 );
        header( 'Content-Type: text/plain; charset=utf-8' );
        header( 'X-Robots-Tag: noindex' );
        echo $key; // phpcs:ignore WordPress.Security.EscapeOutput
        exit;
    }

    private static function host(): string {
        return strtolower( (string) wp_parse_url( home_url(), PHP_URL_HOST ) );
    }

    private static function key_url( string $key ): string {
        return home_url( '/' . $key . '.txt' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function status( array $a, Context $c ): array {
        $key = (string) get_option( self::OPTION, '' );
        if ( '' === $key ) {
            return array( 'enabled' => false, 'next' => 'seo.indexnow_setup creates a key and serves it at /<key>.txt.' );
        }
        $reachable = null;
        try {
            $res       = \WPMCP\Bridge\Util::fetch_own( self::key_url( $key ) );
            $reachable = 200 === (int) $res['status'] && trim( (string) $res['body'] ) === $key;
        } catch ( BridgeError $e ) {
            $reachable = null;
        }

        return array( 'enabled' => true, 'key_location' => self::key_url( $key ), 'key_file_reachable' => $reachable, 'hidden_from_search' => ! get_option( 'blog_public' ), 'note' => 'Keep the key location answering; IndexNow engines fetch it to check that you own the site.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function setup( array $a, Context $c ): array {
        $before = Revisions::snap_option( self::OPTION );
        $key    = (string) get_option( self::OPTION, '' );
        if ( '' === $key || ! empty( $a['regenerate'] ) ) {
            $key = bin2hex( random_bytes( 16 ) );
            update_option( self::OPTION, $key, false );
            Revisions::record( $c, 'option', self::OPTION, $before );
        }
        $c->summary = 'IndexNow key ready';

        return array( 'key_location' => self::key_url( $key ), 'note' => 'The key file is served by the bridge; no file was written. Submit URLs with seo.indexnow_submit.' );
    }

    /**
     * URLs to submit: those given, those of the given post IDs, or the most recently changed published items.
     *
     * @param array<string, mixed> $a Arguments.
     * @return list<string>
     */
    private static function collect( array $a ): array {
        $urls = (array) ( $a['urls'] ?? array() );
        foreach ( (array) ( $a['ids'] ?? array() ) as $id ) {
            $post = get_post( (int) $id );
            if ( $post && 'publish' === $post->post_status && '' === (string) $post->post_password ) {
                $urls[] = (string) get_permalink( $post );
            }
        }
        if ( array() === $urls && ! empty( $a['recent'] ) ) {
            $posts = get_posts( array( 'post_type' => 'any', 'post_status' => 'publish', 'orderby' => 'modified', 'order' => 'DESC', 'posts_per_page' => min( self::MAX_URLS, max( 1, (int) $a['recent'] ) ), 'has_password' => false, 'fields' => 'ids' ) );
            foreach ( $posts as $id ) {
                $urls[] = (string) get_permalink( (int) $id );
            }
        }

        return array_map( 'strval', $urls );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function submit( array $a, Context $c ): array {
        $key = (string) get_option( self::OPTION, '' );
        if ( '' === $key ) {
            throw new BridgeError( 'not_set_up', 'Run seo.indexnow_setup first.', 409 );
        }
        if ( ! get_option( 'blog_public' ) ) {
            throw new BridgeError( 'hidden_from_search', 'This site asks search engines not to index it (Settings > Reading), so nothing is submitted.', 409 );
        }
        $split = Policy::indexnow_urls( self::collect( $a ), self::host() );
        $urls  = array_slice( $split['ok'], 0, self::MAX_URLS );
        if ( array() === $urls ) {
            throw new BridgeError( 'no_urls', 'No valid URLs of this site to submit. Pass urls, ids or recent.' . ( $split['rejected'] ? ' Rejected: ' . wp_json_encode( array_slice( $split['rejected'], 0, 5 ) ) : '' ), 400 );
        }
        $res = wp_remote_post(
            self::ENDPOINT,
            array(
                'timeout' => 20,
                'headers' => array( 'Content-Type' => 'application/json; charset=utf-8' ),
                'body'    => (string) wp_json_encode( array( 'host' => self::host(), 'key' => $key, 'keyLocation' => self::key_url( $key ), 'urlList' => $urls ) ),
            )
        );
        if ( is_wp_error( $res ) ) {
            throw new BridgeError( 'indexnow_failed', 'IndexNow could not be reached: ' . $res->get_error_message(), 502 );
        }
        $code    = (int) wp_remote_retrieve_response_code( $res );
        $meaning = array( 200 => 'accepted', 202 => 'accepted, the key is still being checked', 400 => 'bad request', 403 => 'key not valid: is the key file reachable?', 422 => 'URLs do not belong to the host or the key does not match', 429 => 'too many requests, wait and retry' );
        if ( $code < 200 || $code >= 300 ) {
            throw new BridgeError( 'indexnow_refused', "IndexNow answered HTTP $code (" . ( $meaning[ $code ] ?? 'unexpected' ) . ').', 502 );
        }
        $c->summary = 'IndexNow: ' . count( $urls ) . ' URLs submitted';

        return array( 'submitted' => count( $urls ), 'http' => $code, 'result' => $meaning[ $code ] ?? 'accepted', 'rejected' => array_slice( $split['rejected'], 0, 20 ), 'truncated' => count( $split['ok'] ) > self::MAX_URLS, 'note' => 'Bing, Yandex, Naver, Seznam and Yep share submissions. Google does not use IndexNow.' );
    }
}
