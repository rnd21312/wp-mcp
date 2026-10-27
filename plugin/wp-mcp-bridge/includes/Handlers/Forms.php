<?php
/**
 * forms.* operations: Contact Form 7, Gravity Forms, WPForms and Fluent Forms.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

final class Forms {

    /** @return array<int, string> */
    public static function providers(): array {
        $out = array();
        if ( class_exists( 'WPCF7_ContactForm' ) ) {
            $out[] = 'cf7';
        }
        if ( class_exists( 'GFAPI' ) ) {
            $out[] = 'gravity';
        }
        if ( function_exists( 'wpforms' ) ) {
            $out[] = 'wpforms';
        }
        if ( defined( 'FLUENTFORM' ) ) {
            $out[] = 'fluent';
        }

        return $out;
    }

    private static function provider( array $a ): string {
        $have = self::providers();
        $want = (string) ( $a['provider'] ?? '' );
        if ( '' !== $want ) {
            if ( ! in_array( $want, $have, true ) ) {
                throw new BridgeError( 'no_provider', "Form plugin \"$want\" is not active. Active: " . ( implode( ', ', $have ) ?: 'none' ) . '.', 400 );
            }

            return $want;
        }
        if ( 1 !== count( $have ) ) {
            throw new BridgeError( 'provider_required', 'Pass provider (' . ( implode( ', ', $have ) ?: 'no form plugin is active' ) . ').', 400 );
        }

        return $have[0];
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_list( array $a, Context $c ): array {
        global $wpdb;
        $forms = array();
        foreach ( self::providers() as $p ) {
            switch ( $p ) {
                case 'cf7':
                    foreach ( get_posts( array( 'post_type' => 'wpcf7_contact_form', 'numberposts' => 100, 'post_status' => 'publish' ) ) as $f ) {
                        $forms[] = array( 'provider' => 'cf7', 'id' => $f->ID, 'title' => $f->post_title );
                    }
                    break;
                case 'gravity':
                    foreach ( (array) \GFAPI::get_forms() as $f ) {
                        $forms[] = array( 'provider' => 'gravity', 'id' => (int) $f['id'], 'title' => $f['title'], 'active' => (bool) $f['is_active'] );
                    }
                    break;
                case 'wpforms':
                    foreach ( get_posts( array( 'post_type' => 'wpforms', 'numberposts' => 100, 'post_status' => 'publish' ) ) as $f ) {
                        $forms[] = array( 'provider' => 'wpforms', 'id' => $f->ID, 'title' => $f->post_title );
                    }
                    break;
                case 'fluent':
                    foreach ( (array) $wpdb->get_results( "SELECT id, title FROM {$wpdb->prefix}fluentform_forms ORDER BY id DESC LIMIT 100", ARRAY_A ) as $f ) { // phpcs:ignore WordPress.DB
                        $forms[] = array( 'provider' => 'fluent', 'id' => (int) $f['id'], 'title' => $f['title'] );
                    }
                    break;
            }
        }

        return array( 'forms' => $forms, 'providers' => self::providers() );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_get( array $a, Context $c ): array {
        global $wpdb;
        $p  = self::provider( $a );
        $id = (int) $a['id'];
        switch ( $p ) {
            case 'cf7':
                $f = \WPCF7_ContactForm::get_instance( $id );
                if ( ! $f ) {
                    throw new BridgeError( 'not_found', 'No such form.', 404 );
                }
                $mail = (array) $f->prop( 'mail' );

                return array( 'provider' => $p, 'id' => $id, 'title' => $f->title(), 'form' => $f->prop( 'form' ), 'mail' => array( 'recipient' => $mail['recipient'] ?? '', 'subject' => $mail['subject'] ?? '', 'body' => $mail['body'] ?? '' ), 'shortcode' => $f->shortcode() );
            case 'gravity':
                $f = \GFAPI::get_form( $id );
                if ( ! $f ) {
                    throw new BridgeError( 'not_found', 'No such form.', 404 );
                }

                return array( 'provider' => $p, 'id' => $id, 'title' => $f['title'], 'fields' => array_map( static fn ( $x ) => array( 'id' => $x->id, 'type' => $x->type, 'label' => $x->label, 'required' => (bool) $x->isRequired ), (array) $f['fields'] ), 'notifications' => array_map( static fn ( $n ) => array( 'name' => $n['name'] ?? '', 'to' => $n['to'] ?? '', 'subject' => $n['subject'] ?? '' ), array_values( (array) ( $f['notifications'] ?? array() ) ) ) );
            case 'wpforms':
                $post = get_post( $id );
                if ( ! $post || 'wpforms' !== $post->post_type ) {
                    throw new BridgeError( 'not_found', 'No such form.', 404 );
                }
                $cfg = json_decode( $post->post_content, true ) ?: array();

                return array( 'provider' => $p, 'id' => $id, 'title' => $post->post_title, 'fields' => array_map( static fn ( $x ) => array( 'id' => $x['id'] ?? null, 'type' => $x['type'] ?? '', 'label' => $x['label'] ?? '', 'required' => ! empty( $x['required'] ) ), array_values( (array) ( $cfg['fields'] ?? array() ) ) ) );
            case 'fluent':
                $row = $wpdb->get_row( $wpdb->prepare( "SELECT id, title, status FROM {$wpdb->prefix}fluentform_forms WHERE id = %d", $id ), ARRAY_A ); // phpcs:ignore WordPress.DB
                if ( ! $row ) {
                    throw new BridgeError( 'not_found', 'No such form.', 404 );
                }
                $meta = json_decode( (string) $wpdb->get_var( $wpdb->prepare( "SELECT form_fields FROM {$wpdb->prefix}fluentform_forms WHERE id = %d", $id ) ), true ) ?: array(); // phpcs:ignore WordPress.DB

                return array( 'provider' => $p, 'id' => $id, 'title' => $row['title'], 'fields' => array_map( static fn ( $x ) => array( 'type' => $x['element'] ?? '', 'name' => $x['attributes']['name'] ?? '', 'label' => $x['settings']['label'] ?? '' ), array_values( (array) ( $meta['fields'] ?? array() ) ) ) );
        }
        throw new BridgeError( 'unsupported', 'Unsupported provider.', 400 );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_save( array $a, Context $c ): array {
        if ( ! class_exists( 'WPCF7_ContactForm' ) ) {
            throw new BridgeError( 'no_provider', 'Only Contact Form 7 can be edited here, and it is not active. Use rest.call for other form plugins.', 400 );
        }
        $id   = (int) ( $a['id'] ?? 0 );
        $form = $id ? \WPCF7_ContactForm::get_instance( $id ) : \WPCF7_ContactForm::get_template();
        if ( ! $form ) {
            throw new BridgeError( 'not_found', 'No such form.', 404 );
        }
        $before = $id ? Revisions::snap_post( $id ) : null;
        if ( isset( $a['title'] ) ) {
            $form->set_title( sanitize_text_field( (string) $a['title'] ) );
        }
        $props = array();
        if ( isset( $a['form'] ) ) {
            $props['form'] = Util::html( (string) $a['form'], $c );
        }
        if ( isset( $a['mail_to'] ) || isset( $a['mail_subject'] ) || isset( $a['mail_body'] ) ) {
            $mail = (array) $form->prop( 'mail' );
            foreach ( array( 'mail_to' => 'recipient', 'mail_subject' => 'subject', 'mail_body' => 'body' ) as $arg => $key ) {
                if ( isset( $a[ $arg ] ) ) {
                    $mail[ $key ] = sanitize_textarea_field( (string) $a[ $arg ] );
                }
            }
            $props['mail'] = $mail;
        }
        if ( $props ) {
            $form->set_properties( $props );
        }
        $saved = $form->save();
        if ( ! $saved ) {
            throw new BridgeError( 'save_failed', 'Contact Form 7 could not save the form.', 500 );
        }
        Revisions::record( $c, 'post', (string) $saved, $before );
        $c->summary = ( $id ? 'updated' : 'created' ) . " CF7 form #$saved";

        return array( 'id' => (int) $saved, 'shortcode' => '[contact-form-7 id="' . (int) $saved . '"]' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_entries( array $a, Context $c ): array {
        global $wpdb;
        $p              = self::provider( $a );
        [ $page, $per ] = Util::paging( $a, 50 );
        $id             = $a['id'];
        switch ( $p ) {
            case 'gravity':
                $entries = \GFAPI::get_entries( (int) $id, array(), null, array( 'offset' => ( $page - 1 ) * $per, 'page_size' => $per ) );

                return array( 'provider' => $p, 'entries' => is_wp_error( $entries ) ? array() : array_map( static fn ( $e ) => array_filter( (array) $e, static fn ( $k ) => ! in_array( $k, array( 'ip', 'user_agent', 'source_url', 'created_by' ), true ), ARRAY_FILTER_USE_KEY ), $entries ), 'page' => $page );
            case 'fluent':
                $rows = (array) $wpdb->get_results( $wpdb->prepare( "SELECT id, status, response, created_at FROM {$wpdb->prefix}fluentform_submissions WHERE form_id = %d ORDER BY id DESC LIMIT %d OFFSET %d", (int) $id, $per, ( $page - 1 ) * $per ), ARRAY_A ); // phpcs:ignore WordPress.DB

                return array( 'provider' => $p, 'entries' => array_map( static fn ( $r ) => array( 'id' => (int) $r['id'], 'status' => $r['status'], 'created' => $r['created_at'], 'data' => json_decode( (string) $r['response'], true ) ), $rows ), 'page' => $page );
            case 'cf7':
                if ( ! post_type_exists( 'flamingo_inbound' ) ) {
                    return array( 'provider' => $p, 'entries' => array(), 'note' => 'Contact Form 7 does not store submissions. Install the Flamingo plugin to keep them.' );
                }
                $channel = get_post_field( 'post_name', (int) $id );
                $posts   = get_posts( array( 'post_type' => 'flamingo_inbound', 'numberposts' => $per, 'offset' => ( $page - 1 ) * $per, 'tax_query' => array( array( 'taxonomy' => 'flamingo_inbound_channel', 'field' => 'slug', 'terms' => $channel ) ) ) ); // phpcs:ignore WordPress.DB.SlowDBQuery

                return array( 'provider' => $p, 'entries' => array_map( static fn ( $e ) => array( 'id' => $e->ID, 'date' => $e->post_date, 'subject' => $e->post_title, 'fields' => Policy::redact( array_filter( (array) get_post_meta( $e->ID ), static fn ( $k ) => str_starts_with( (string) $k, '_field_' ), ARRAY_FILTER_USE_KEY ) ) ), $posts ), 'page' => $page );
        }

        return array( 'provider' => $p, 'entries' => array(), 'note' => 'This provider does not expose entries in its free version, or the bridge has no reader for it. Try rest.call.' );
    }
}
