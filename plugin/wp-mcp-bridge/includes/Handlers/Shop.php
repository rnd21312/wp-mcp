<?php
/**
 * shop.* operations: WooCommerce through its own REST controllers, so Woo's validation always applies.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Levels;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

final class Shop {

    /**
     * @param array<string, mixed> $params Query (GET) or body.
     * @return mixed
     */
    private static function wc( string $method, string $path, array $params = array() ) {
        if ( ! class_exists( 'WooCommerce' ) ) {
            throw new BridgeError( 'no_woocommerce', 'WooCommerce is not active on this site.', 400 );
        }
        $request = new \WP_REST_Request( $method, '/wc/v3' . $path );
        if ( 'GET' === $method || 'DELETE' === $method ) {
            $request->set_query_params( $params );
        } else {
            $request->set_header( 'Content-Type', 'application/json' );
            $request->set_body( (string) wp_json_encode( $params ) );
            $request->set_body_params( $params );
        }
        $response = rest_do_request( $request );
        $data     = rest_get_server()->response_to_data( $response, false );
        if ( $response->get_status() >= 400 ) {
            throw new BridgeError( 'woocommerce_error', is_array( $data ) && isset( $data['message'] ) ? wp_strip_all_tags( (string) $data['message'] ) : 'WooCommerce refused the request.', 400, array( 'code' => $data['code'] ?? null ) );
        }

        return $data;
    }

    /** @param array<string, mixed> $p Product data. @return array<string, mixed> */
    private static function product_brief( array $p ): array {
        return array(
            'id' => $p['id'], 'name' => $p['name'], 'type' => $p['type'], 'status' => $p['status'], 'sku' => $p['sku'], 'price' => $p['price'], 'regular_price' => $p['regular_price'], 'sale_price' => $p['sale_price'],
            'stock_status' => $p['stock_status'], 'stock_quantity' => $p['stock_quantity'], 'categories' => array_column( (array) $p['categories'], 'name' ), 'url' => $p['permalink'], 'image' => $p['images'][0]['src'] ?? null,
        );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_status( array $a, Context $c ): array {
        if ( ! class_exists( 'WooCommerce' ) ) {
            return array( 'active' => false );
        }
        $counts = wp_count_posts( 'product' );
        $out    = array( 'active' => true, 'version' => WC()->version, 'currency' => get_woocommerce_currency(), 'products' => array( 'published' => (int) $counts->publish, 'draft' => $c->can( 'draft' ) ? (int) $counts->draft : null ), 'pages' => array( 'shop' => wc_get_page_id( 'shop' ), 'cart' => wc_get_page_id( 'cart' ), 'checkout' => wc_get_page_id( 'checkout' ), 'account' => wc_get_page_id( 'myaccount' ) ) );
        if ( $c->can( 'admin' ) ) {
            $out['orders_by_status'] = array_filter( array_map( static fn ( $s ) => (int) wc_orders_count( $s ), array( 'pending' => 'pending', 'processing' => 'processing', 'on-hold' => 'on-hold', 'completed' => 'completed' ) ) );
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_products_list( array $a, Context $c ): array {
        $status = sanitize_key( (string) ( $a['status'] ?? 'publish' ) );
        if ( 'publish' !== $status ) {
            $c->need( 'draft', 'Only published products are visible at read level.' );
        }
        [ $page, $per ] = Util::paging( $a );
        $params         = array( 'page' => $page, 'per_page' => $per, 'status' => $status );
        if ( ! empty( $a['search'] ) ) {
            $params['search'] = (string) $a['search'];
        }
        if ( ! empty( $a['category'] ) ) {
            $term = get_term_by( 'slug', sanitize_title( (string) $a['category'] ), 'product_cat' );
            if ( $term ) {
                $params['category'] = (string) $term->term_id;
            }
        }
        $list = self::wc( 'GET', '/products', $params );

        return array( 'products' => array_map( array( self::class, 'product_brief' ), (array) $list ), 'page' => $page );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_product_get( array $a, Context $c ): array {
        $p = self::wc( 'GET', '/products/' . (int) $a['id'] );
        if ( 'publish' !== $p['status'] ) {
            $c->need( 'draft', 'This product is not published.' );
        }

        return self::product_brief( $p ) + array( 'description' => $p['description'], 'short_description' => $p['short_description'], 'attributes' => array_map( static fn ( $x ) => array( 'name' => $x['name'], 'options' => $x['options'], 'variation' => $x['variation'] ), (array) $p['attributes'] ), 'variations' => $p['variations'], 'images' => array_column( (array) $p['images'], 'src' ), 'manage_stock' => $p['manage_stock'] );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<int, int>
     */
    private static function category_ids( array $names ): array {
        $ids = array();
        foreach ( $names as $n ) {
            if ( is_numeric( $n ) ) {
                $ids[] = (int) $n;
                continue;
            }
            $term = term_exists( (string) $n, 'product_cat' );
            if ( ! $term ) {
                $term = wp_insert_term( (string) $n, 'product_cat' );
            }
            if ( ! is_wp_error( $term ) ) {
                $ids[] = (int) ( is_array( $term ) ? $term['term_id'] : $term );
            }
        }

        return $ids;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_product_save( array $a, Context $c ): array {
        $id       = (int) ( $a['id'] ?? 0 );
        $existing = $id ? get_post( $id ) : null;
        if ( $id && ( ! $existing || 'product' !== $existing->post_type ) ) {
            throw new BridgeError( 'not_found', 'No such product.', 404 );
        }
        $status = isset( $a['status'] ) ? sanitize_key( (string) $a['status'] ) : ( $existing->post_status ?? 'draft' );
        $need   = Policy::level_for_status( $status );
        if ( $existing ) {
            $need = Levels::max( $need, Policy::level_for_status( $existing->post_status ) );
        }
        $c->need( $need, 'Publishing or editing a live product needs live level.' );

        $body = array( 'status' => $status );
        foreach ( array( 'name', 'type', 'sku', 'regular_price', 'sale_price', 'manage_stock', 'stock_quantity' ) as $f ) {
            if ( isset( $a[ $f ] ) ) {
                $body[ $f ] = $a[ $f ];
            }
        }
        foreach ( array( 'description', 'short_description' ) as $f ) {
            if ( isset( $a[ $f ] ) ) {
                $body[ $f ] = Util::html( (string) $a[ $f ], $c );
            }
        }
        if ( isset( $a['categories'] ) ) {
            $body['categories'] = array_map( static fn ( $i ) => array( 'id' => $i ), self::category_ids( (array) $a['categories'] ) );
        }
        if ( isset( $a['images'] ) ) {
            $body['images'] = array_map( static fn ( $i ) => array( 'id' => (int) $i ), (array) $a['images'] );
        }
        if ( isset( $a['attributes'] ) ) {
            $body['attributes'] = array_map( static fn ( $x ) => array( 'name' => (string) ( $x['name'] ?? '' ), 'options' => array_map( 'strval', (array) ( $x['options'] ?? array() ) ), 'visible' => true, 'variation' => ! empty( $x['variation'] ) ), (array) $a['attributes'] );
        }
        $before = $existing ? Revisions::snap_post( $id ) : null;
        $p      = $id ? self::wc( 'PUT', '/products/' . $id, $body ) : self::wc( 'POST', '/products', $body );
        Revisions::record( $c, 'post', (string) $p['id'], $before );
        $c->summary = ( $id ? 'updated' : 'created' ) . " product #{$p['id']} ({$p['status']})";

        return self::product_brief( $p );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_product_delete( array $a, Context $c ): array {
        $p = self::wc( 'GET', '/products/' . (int) $a['id'] );

        return array( 'will_delete' => self::product_brief( $p ), 'permanent' => true, 'variations' => count( (array) $p['variations'] ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_product_delete( array $a, Context $c ): array {
        $p = self::wc( 'DELETE', '/products/' . (int) $a['id'], array( 'force' => true ) );
        $c->summary = "deleted product #{$p['id']} \"{$p['name']}\" permanently";

        return array( 'deleted' => $p['id'], 'name' => $p['name'] );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_stock_update( array $a, Context $c ): array {
        $done = array();
        foreach ( array_slice( (array) $a['items'], 0, 50 ) as $item ) {
            $item = (array) $item;
            $id   = (int) ( $item['id'] ?? 0 );
            if ( ! $id || 'product' !== get_post_type( $id ) && 'product_variation' !== get_post_type( $id ) ) {
                continue;
            }
            $body = array();
            if ( isset( $item['stock_quantity'] ) ) {
                $body['manage_stock']   = true;
                $body['stock_quantity'] = (int) $item['stock_quantity'];
            }
            foreach ( array( 'regular_price', 'sale_price' ) as $f ) {
                if ( isset( $item[ $f ] ) ) {
                    $body[ $f ] = (string) $item[ $f ];
                }
            }
            if ( ! $body ) {
                continue;
            }
            $before = Revisions::snap_post( $id );
            $path   = 'product_variation' === get_post_type( $id ) ? '/products/' . wp_get_post_parent_id( $id ) . '/variations/' . $id : '/products/' . $id;
            self::wc( 'PUT', $path, $body );
            Revisions::record( $c, 'post', (string) $id, $before );
            $done[] = $id;
        }
        $c->summary = 'stock/price update on ' . count( $done ) . ' products';

        return array( 'updated' => $done );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_coupons_list( array $a, Context $c ): array {
        [ $page, $per ] = Util::paging( $a );

        return array( 'coupons' => array_map( static fn ( $x ) => array( 'id' => $x['id'], 'code' => $x['code'], 'type' => $x['discount_type'], 'amount' => $x['amount'], 'expires' => $x['date_expires'], 'used' => $x['usage_count'], 'limit' => $x['usage_limit'] ), (array) self::wc( 'GET', '/coupons', array( 'page' => $page, 'per_page' => $per ) ) ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_coupon_save( array $a, Context $c ): array {
        $body = array( 'code' => sanitize_text_field( (string) $a['code'] ) );
        foreach ( array( 'discount_type', 'amount', 'date_expires', 'usage_limit' ) as $f ) {
            if ( isset( $a[ $f ] ) ) {
                $body[ $f ] = $a[ $f ];
            }
        }
        $id     = (int) ( $a['id'] ?? 0 );
        $before = $id ? Revisions::snap_post( $id ) : null;
        $x      = $id ? self::wc( 'PUT', '/coupons/' . $id, $body ) : self::wc( 'POST', '/coupons', $body );
        Revisions::record( $c, 'post', (string) $x['id'], $before );
        $c->summary = "saved coupon {$x['code']}";

        return array( 'id' => $x['id'], 'code' => $x['code'], 'type' => $x['discount_type'], 'amount' => $x['amount'] );
    }

    /** @param array<string, mixed> $o Order. @return array<string, mixed> */
    private static function order_view( array $o, bool $full ): array {
        $base = array( 'id' => $o['id'], 'status' => $o['status'], 'total' => $o['total'], 'currency' => $o['currency'], 'created' => $o['date_created'], 'payment_method' => $o['payment_method_title'], 'customer' => trim( ( $o['billing']['first_name'] ?? '' ) . ' ' . ( $o['billing']['last_name'] ?? '' ) ), 'items' => array_map( static fn ( $i ) => $i['quantity'] . ' x ' . $i['name'], (array) $o['line_items'] ) );
        if ( $full ) {
            $base['billing']  = $o['billing'];
            $base['shipping'] = $o['shipping'];
            $base['note']     = $o['customer_note'];
        }

        return $base;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_orders_list( array $a, Context $c ): array {
        [ $page, $per ] = Util::paging( $a );
        $params         = array( 'page' => $page, 'per_page' => $per );
        if ( ! empty( $a['status'] ) ) {
            $params['status'] = (string) $a['status'];
        }

        return array( 'orders' => array_map( static fn ( $o ) => self::order_view( $o, false ), (array) self::wc( 'GET', '/orders', $params ) ), 'page' => $page );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_order_get( array $a, Context $c ): array {
        return self::order_view( (array) self::wc( 'GET', '/orders/' . (int) $a['id'] ), true );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_order_update( array $a, Context $c ): array {
        $o = (array) self::wc( 'GET', '/orders/' . (int) $a['id'] );

        return array( 'order' => self::order_view( $o, false ), 'change' => array_intersect_key( $a, array_flip( array( 'status', 'note' ) ) ), 'effect' => 'Changing the status can email the customer and adjust stock.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_order_update( array $a, Context $c ): array {
        $id = (int) $a['id'];
        if ( isset( $a['status'] ) ) {
            self::wc( 'PUT', '/orders/' . $id, array( 'status' => sanitize_key( (string) $a['status'] ) ) );
        }
        if ( ! empty( $a['note'] ) ) {
            self::wc( 'POST', '/orders/' . $id . '/notes', array( 'note' => sanitize_textarea_field( (string) $a['note'] ), 'customer_note' => false ) );
        }
        $c->summary = "updated order #$id";

        return self::order_view( (array) self::wc( 'GET', '/orders/' . $id ), false );
    }

    /**
     * Payment gateways with their non-secret settings.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_gateways_list( array $a, Context $c ): array {
        if ( ! function_exists( 'WC' ) ) {
            throw new BridgeError( 'no_woocommerce', 'WooCommerce is not active.', 400 );
        }
        $out = array();
        foreach ( WC()->payment_gateways()->payment_gateways() as $id => $g ) {
            $settings = array();
            foreach ( (array) $g->settings as $k => $v ) {
                $settings[ $k ] = preg_match( '/key|secret|token|password|merchant/i', (string) $k ) ? '(hidden)' : $v;
            }
            $out[] = array( 'id' => $id, 'title' => $g->get_method_title(), 'enabled' => 'yes' === $g->enabled, 'settings' => $settings );
        }

        return array( 'gateways' => $out );
    }

    /**
     * Turns a gateway on or off and edits non-secret settings (secret fields are entered by the owner in WooCommerce).
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_gateway_set( array $a, Context $c ): array {
        if ( ! function_exists( 'WC' ) ) {
            throw new BridgeError( 'no_woocommerce', 'WooCommerce is not active.', 400 );
        }
        $id = sanitize_key( (string) $a['id'] );
        $gw = WC()->payment_gateways()->payment_gateways()[ $id ] ?? null;
        if ( ! $gw ) {
            throw new BridgeError( 'not_found', 'No such payment gateway.', 404 );
        }
        $opts = (array) get_option( $gw->get_option_key(), array() );
        if ( isset( $a['enabled'] ) ) {
            $opts['enabled'] = $a['enabled'] ? 'yes' : 'no';
        }
        foreach ( (array) ( $a['settings'] ?? array() ) as $k => $v ) {
            if ( preg_match( '/key|secret|token|password|merchant/i', (string) $k ) ) {
                throw new BridgeError( 'forbidden', "Setting \"$k\" looks like a secret; the site owner enters it in WooCommerce settings.", 403 );
            }
            $opts[ sanitize_key( (string) $k ) ] = is_scalar( $v ) ? sanitize_text_field( (string) $v ) : $v;
        }
        update_option( $gw->get_option_key(), $opts );
        $c->summary = "updated gateway $id";

        return array( 'id' => $id, 'enabled' => 'yes' === ( $opts['enabled'] ?? 'no' ) );
    }

    /**
     * Shipping zones with their methods.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_shipping_zones( array $a, Context $c ): array {
        if ( ! class_exists( '\WC_Shipping_Zones' ) ) {
            throw new BridgeError( 'no_woocommerce', 'WooCommerce is not active.', 400 );
        }
        $out = array();
        foreach ( \WC_Shipping_Zones::get_zones() as $z ) {
            $out[] = array( 'id' => $z['id'], 'name' => $z['zone_name'], 'locations' => wp_list_pluck( (array) $z['zone_locations'], 'code' ), 'methods' => array_map( static fn( $m ) => array( 'instance' => $m->get_instance_id(), 'id' => $m->id, 'title' => $m->get_title(), 'enabled' => 'yes' === $m->enabled ), array_values( (array) $z['shipping_methods'] ) ) );
        }

        return array( 'zones' => $out );
    }
}
