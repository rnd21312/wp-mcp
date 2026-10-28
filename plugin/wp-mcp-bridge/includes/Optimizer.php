<?php
/**
 * Image and video shrinking/conversion. Used by media.upload, media.register, media.optimize and (when enabled)
 * by ordinary uploads in the WordPress media library.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Optimizer {

    public const OPTION = 'wpm_bridge_media';

    private const IMAGE_FORMATS = array( 'webp' => 'image/webp', 'jpeg' => 'image/jpeg', 'png' => 'image/png', 'avif' => 'image/avif' );
    private const VIDEO_FORMATS = array( 'mp4' => 'video/mp4', 'webm' => 'video/webm' );

    public static function init(): void {
        add_filter( 'wp_handle_upload', array( self::class, 'on_upload' ) );
    }

    /** @return array{auto: bool, max_width: int, quality: int, format: string} */
    public static function settings(): array {
        $s = (array) get_option( self::OPTION, array() );

        return array(
            'auto'      => ! empty( $s['auto'] ),
            'max_width' => max( 0, (int) ( $s['max_width'] ?? 2560 ) ),
            'quality'   => max( 30, min( 100, (int) ( $s['quality'] ?? 82 ) ) ),
            'format'    => isset( self::IMAGE_FORMATS[ $s['format'] ?? '' ] ) ? (string) $s['format'] : 'keep',
        );
    }

    /** @param array<string, mixed> $s Posted settings. */
    public static function save_settings( array $s ): void {
        update_option( self::OPTION, array( 'auto' => ! empty( $s['auto'] ), 'max_width' => (int) ( $s['max_width'] ?? 2560 ), 'quality' => (int) ( $s['quality'] ?? 82 ), 'format' => (string) ( $s['format'] ?? 'keep' ) ), false );
    }

    /**
     * Options from operation arguments: `optimize` is true (use the saved settings) or {max_width, quality, format}.
     *
     * @param mixed $arg The optimize argument.
     * @return array{max_width: int, quality: int, format: string}|null
     */
    public static function options( $arg ): ?array {
        if ( empty( $arg ) ) {
            return null;
        }
        $o = self::settings();
        $a = is_array( $arg ) ? $arg : array();
        $f = (string) ( $a['format'] ?? $o['format'] );

        return array(
            'max_width' => max( 0, (int) ( $a['max_width'] ?? $o['max_width'] ) ),
            'quality'   => max( 30, min( 100, (int) ( $a['quality'] ?? $o['quality'] ) ) ),
            'format'    => isset( self::IMAGE_FORMATS[ $f ] ) || isset( self::VIDEO_FORMATS[ $f ] ) ? $f : 'keep',
        );
    }

    /** Ordinary uploads from the media library / editors. @param array<string, mixed> $upload Result of wp_handle_upload. @return array<string, mixed> */
    public static function on_upload( $upload ) {
        $o = self::settings();
        if ( ! $o['auto'] || ! is_array( $upload ) || empty( $upload['file'] ) || ! str_starts_with( (string) ( $upload['type'] ?? '' ), 'image/' ) ) {
            return $upload;
        }
        try {
            $r = self::image( (string) $upload['file'], $o );
        } catch ( \Throwable $e ) {
            return $upload;
        }
        if ( ! $r ) {
            return $upload;
        }
        $upload['file'] = $r['file'];
        $upload['type'] = $r['mime'];
        $upload['url']  = substr( (string) $upload['url'], 0, (int) strrpos( (string) $upload['url'], '/' ) + 1 ) . basename( $r['file'] );

        return $upload;
    }

    /**
     * Shrinks/converts one image file. The original is removed only when a smaller (or converted) file was written.
     *
     * @param array{max_width: int, quality: int, format: string} $o Options.
     * @return array{file: string, mime: string, before: int, after: int}|null null when nothing was gained.
     */
    public static function image( string $path, array $o ): ?array {
        if ( ! is_file( $path ) ) {
            return null;
        }
        wp_raise_memory_limit( 'image' );
        $mime = (string) wp_check_filetype( $path )['type'];
        if ( ! in_array( $mime, array( 'image/jpeg', 'image/png', 'image/webp', 'image/avif' ), true ) ) {
            return null; // gif/svg/others stay untouched (animation, vectors).
        }
        $target = self::IMAGE_FORMATS[ $o['format'] ] ?? $mime;
        if ( ! wp_image_editor_supports( array( 'mime_type' => $target ) ) ) {
            $target = $mime;
        }
        $editor = wp_get_image_editor( $path );
        if ( is_wp_error( $editor ) ) {
            return null;
        }
        $before = (int) filesize( $path );
        $size   = $editor->get_size();
        $resize = $o['max_width'] > 0 && (int) $size['width'] > $o['max_width'];
        if ( $resize ) {
            $editor->resize( $o['max_width'], null, false );
        }
        if ( ! $resize && $target === $mime && ( 'image/png' === $mime ) ) {
            return null; // PNG is lossless: re-saving only helps when resizing or converting.
        }
        $editor->set_quality( $o['quality'] );
        $dir  = dirname( $path );
        $ext  = array_search( $target, self::IMAGE_FORMATS, true );
        $ext  = 'jpeg' === $ext ? 'jpg' : (string) $ext;
        $name = wp_unique_filename( $dir, pathinfo( $path, PATHINFO_FILENAME ) . '-opt.' . $ext );
        $out  = $editor->save( $dir . '/' . $name, $target );
        if ( is_wp_error( $out ) || empty( $out['path'] ) ) {
            return null;
        }
        $after = (int) filesize( $out['path'] );
        if ( $target === $mime && ! $resize && $after >= $before ) {
            @unlink( $out['path'] ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
            return null;
        }
        // Keep a clean name: photo.jpg -> photo.webp (the temporary "-opt" suffix is dropped when free).
        $final = $dir . '/' . wp_unique_filename( $dir, pathinfo( $path, PATHINFO_FILENAME ) . '.' . $ext );
        if ( $final !== $path && @rename( $out['path'], $final ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors
            $out['path'] = $final;
        }
        if ( $out['path'] !== $path ) {
            @unlink( $path ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        }

        return array( 'file' => $out['path'], 'mime' => $target, 'before' => $before, 'after' => $after );
    }

    public static function ffmpeg(): string {
        static $bin = null;
        if ( null === $bin ) {
            $bin = '';
            if ( function_exists( 'proc_open' ) && ! in_array( 'proc_open', array_map( 'trim', explode( ',', (string) ini_get( 'disable_functions' ) ) ), true ) ) {
                foreach ( array( 'ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg' ) as $cand ) {
                    $p = @proc_open( array( $cand, '-version' ), array( 1 => array( 'pipe', 'w' ), 2 => array( 'pipe', 'w' ) ), $pipes ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
                    if ( is_resource( $p ) ) {
                        stream_get_contents( $pipes[1] );
                        $bin = 0 === proc_close( $p ) ? $cand : '';
                        if ( '' !== $bin ) {
                            break;
                        }
                    }
                }
            }
        }

        return $bin;
    }

    /**
     * Re-encodes a video with ffmpeg (H.264/AAC mp4 or VP9/Opus webm), max height from max_width, faststart for the web.
     *
     * @param array{max_width: int, quality: int, format: string} $o Options (quality 30-100 maps to CRF).
     * @return array{file: string, mime: string, before: int, after: int}
     */
    public static function video( string $path, array $o ): array {
        $bin = self::ffmpeg();
        if ( '' === $bin ) {
            throw new BridgeError( 'no_ffmpeg', 'Video compression needs ffmpeg on the server and it is not available here. Compress the video on your computer (e.g. HandBrake) and upload the result.', 501 );
        }
        $fmt   = isset( self::VIDEO_FORMATS[ $o['format'] ] ) ? $o['format'] : 'mp4';
        $crf   = (int) round( 51 - ( $o['quality'] - 30 ) * ( 51 - 18 ) / 70 ); // quality 100 -> crf 18, 30 -> crf 51.
        $crf   = max( 20, min( 38, $crf ) );
        $dir   = dirname( $path );
        $out   = $dir . '/' . wp_unique_filename( $dir, pathinfo( $path, PATHINFO_FILENAME ) . '-opt.' . $fmt );
        $vf    = $o['max_width'] > 0 ? 'scale=\'min(' . $o['max_width'] . ',iw)\':-2' : 'scale=iw:-2';
        $codec = 'webm' === $fmt ? array( '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', (string) $crf, '-c:a', 'libopus', '-b:a', '96k' ) : array( '-c:v', 'libx264', '-preset', 'veryfast', '-crf', (string) $crf, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart' );
        $cmd   = array_merge( array( $bin, '-y', '-i', $path, '-vf', $vf ), $codec, array( '-map_metadata', '-1', $out ) );
        $proc  = proc_open( $cmd, array( 1 => array( 'pipe', 'w' ), 2 => array( 'pipe', 'w' ) ), $pipes );
        if ( ! is_resource( $proc ) ) {
            throw new BridgeError( 'ffmpeg_failed', 'Could not start ffmpeg.', 500 );
        }
        stream_set_blocking( $pipes[1], false );
        stream_set_blocking( $pipes[2], false );
        $deadline = time() + 150;
        while ( proc_get_status( $proc )['running'] ) {
            if ( time() > $deadline ) {
                proc_terminate( $proc, 9 );
                @unlink( $out ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
                throw new BridgeError( 'ffmpeg_timeout', 'Compressing this video takes longer than the 150 s a request may use. Compress it on your computer and upload the result.', 504 );
            }
            stream_get_contents( $pipes[1] );
            stream_get_contents( $pipes[2] );
            usleep( 200000 );
        }
        proc_close( $proc );
        $before = (int) filesize( $path );
        $after  = is_file( $out ) ? (int) filesize( $out ) : 0;
        if ( 0 === $after ) {
            throw new BridgeError( 'ffmpeg_failed', 'ffmpeg could not convert this video.', 500 );
        }
        if ( $after >= $before && strtolower( pathinfo( $path, PATHINFO_EXTENSION ) ) === $fmt ) {
            @unlink( $out ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
            return array( 'file' => $path, 'mime' => self::VIDEO_FORMATS[ $fmt ], 'before' => $before, 'after' => $before );
        }
        $final = $dir . '/' . wp_unique_filename( $dir, pathinfo( $path, PATHINFO_FILENAME ) . '.' . $fmt );
        if ( @rename( $out, $final ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors
            $out = $final;
        }
        if ( $out !== $path ) {
            @unlink( $path ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        }

        return array( 'file' => $out, 'mime' => self::VIDEO_FORMATS[ $fmt ], 'before' => $before, 'after' => $after );
    }

    /** Image or video, chosen from the file type. @return array{file: string, mime: string, before: int, after: int}|null */
    public static function any( string $path, array $o ): ?array {
        $mime = (string) wp_check_filetype( $path )['type'];

        return str_starts_with( $mime, 'video/' ) ? self::video( $path, $o ) : self::image( $path, $o );
    }
}
