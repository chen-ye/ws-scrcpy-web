import type { DisplayInfo } from '../DisplayInfo';
import Rect from '../Rect';
import ScreenInfo from '../ScreenInfo';
import Size from '../Size';
import VideoSettings from '../VideoSettings';
import { OBU_TYPE, obuType, parseAv1ConfigRecord, parseAv1SequenceHeader } from './av1-utils';
import { BaseCanvasBasedPlayer } from './BaseCanvasBasedPlayer';
import { BasePlayer } from './BasePlayer';
import { parseSPS, stripEmulationPrevention } from './h264-utils';
import { HEVC_NAL_TYPE, hevcNalType, parseHevcSPS } from './h265-utils';
import { findFirstNaluOffset, findNaluByHeader } from './naluScanner';
import { buildDecoderConfig } from './webCodecsConfig';

function toHex(value: number) {
    return value.toString(16).padStart(2, '0').toUpperCase();
}

export class WebCodecsPlayer extends BaseCanvasBasedPlayer {
    public static override readonly storageKeyPrefix = 'WebCodecsPlayer';
    public static override readonly playerFullName = 'connect';
    public static override readonly playerCodeName = 'webcodecs';

    public static override readonly preferredVideoSettings: VideoSettings = new VideoSettings({
        lockedVideoOrientation: -1,
        bitrate: 8000000,
        maxFps: 15,
        iFrameInterval: 2,
        bounds: new Size(0, 0),
        sendFrameMeta: false,
    });

    public static override isSupported(): boolean {
        return typeof VideoDecoder === 'function' && typeof VideoDecoder.isConfigSupported === 'function';
    }

    private static parseSPSCodecString(data: Uint8Array): { codec: string; width: number; height: number } {
        // Strip RBSP emulation-prevention bytes before bitstream parsing, mirroring
        // the H.265 path (parseHevcSPS strips internally). An SPS containing a
        // 00 00 03 triple would otherwise be mis-parsed (finding #42).
        const {
            profile_idc,
            constraint_set_flags,
            level_idc,
            pic_width_in_mbs_minus1,
            frame_crop_left_offset,
            frame_crop_right_offset,
            frame_mbs_only_flag,
            pic_height_in_map_units_minus1,
            frame_crop_top_offset,
            frame_crop_bottom_offset,
            sar,
        } = parseSPS(stripEmulationPrevention(data));

        const sarScale = sar[0] / sar[1];
        const codec = `avc1.${[profile_idc, constraint_set_flags, level_idc].map(toHex).join('')}`;
        const width = Math.ceil(
            ((pic_width_in_mbs_minus1 + 1) * 16 - frame_crop_left_offset * 2 - frame_crop_right_offset * 2) * sarScale,
        );
        const height =
            (2 - frame_mbs_only_flag) * (pic_height_in_map_units_minus1 + 1) * 16 -
            (frame_mbs_only_flag ? 2 : 4) * (frame_crop_top_offset + frame_crop_bottom_offset);
        return { codec, width, height };
    }

    public override readonly supportsScreenshot = true;
    private context: CanvasRenderingContext2D;
    private decoder: VideoDecoder;
    private configData?: Uint8Array | undefined;
    private detectedCodec: 'h264' | 'h265' | 'av1' | null = null;
    private metadataWidth = 0;
    private metadataHeight = 0;
    private loggedFrameSize = false;

    constructor(udid: string, displayInfo?: DisplayInfo, name = WebCodecsPlayer.playerFullName) {
        super(udid, displayInfo, name, WebCodecsPlayer.storageKeyPrefix);
        const context = this.tag.getContext('2d');
        if (!context) {
            throw Error('Failed to get 2d context from canvas');
        }
        this.context = context;
        this.decoder = this.createDecoder();
    }

    private createDecoder(): VideoDecoder {
        return new VideoDecoder({
            output: (frame) => {
                if (!this.loggedFrameSize) {
                    console.log(
                        `[WebCodecsPlayer] First decoded frame: display=${frame.displayWidth}x${frame.displayHeight} coded=${frame.codedWidth}x${frame.codedHeight} canvas=${this.tag.width}x${this.tag.height}`,
                    );
                    this.loggedFrameSize = true;
                }
                this.onFrameDecoded(frame.displayWidth, frame.displayHeight, frame);
            },
            error: (error: DOMException) => {
                console.error('[WebCodecsPlayer] VideoDecoder error:', error, `code: ${error.code}`);
            },
        });
    }

    /**
     * Called by ScrcpyDemuxer via StreamClientScrcpy with pre-parsed frame metadata.
     * Replaces the old pushFrame(Uint8Array) → decode() pipeline.
     */
    public pushVideoFrame(data: Uint8Array, pts: bigint, isConfig: boolean, isKeyframe: boolean): void {
        // Track stats via BasePlayer. Pass the demuxer's real keyframe flag so the
        // shared signature carries it (works for H.264/H.265/AV1) — see finding #43.
        BasePlayer.prototype.pushFrame.call(this, data, isKeyframe);

        if (isConfig) {
            console.log('[WebCodecsPlayer] Received config frame, size =', data.length);
            let result: { codec: string; width?: number; height?: number } | null = null;
            try {
                result = this.parseConfig(data);
            } catch (e) {
                console.error('[WebCodecsPlayer] parseConfig error:', e);
            }
            if (!result) {
                console.warn('[WebCodecsPlayer] parseConfig returned null, using fallback avc1.42E01E');
                this.detectedCodec = 'h264';
                result = { codec: 'avc1.42E01E' };
            }
            if (result) {
                const codedW = result.width || this.metadataWidth;
                const codedH = result.height || this.metadataHeight;
                const displayW = this.metadataWidth || result.width;
                const displayH = this.metadataHeight || result.height;
                if (displayW && displayH && displayW > 0 && displayH > 0) {
                    this.scaleCanvas(displayW, displayH);
                }
                if (this.decoder.state === 'configured') {
                    this.decoder.flush().catch(() => {});
                }
                console.log('[WebCodecsPlayer] Configuring VideoDecoder:', result.codec, `${codedW}x${codedH}`);
                try {
                    this.decoder.configure(
                        buildDecoderConfig({
                            codec: result.codec,
                            detectedCodec: this.detectedCodec,
                            codedWidth: codedW,
                            codedHeight: codedH,
                            configData: data,
                        }),
                    );
                    console.log('[WebCodecsPlayer] Decoder state after configure:', this.decoder.state);
                } catch (err) {
                    console.error('[WebCodecsPlayer] Decoder configure exception:', err);
                }
            }
            this.configData = new Uint8Array(data);
            return;
        }

        if (this.decoder.state !== 'configured') {
            console.warn('[WebCodecsPlayer] Dropping frame because decoder is:', this.decoder.state);
            return;
        }

        if (isKeyframe && this.configData) {
            if (!this.receivedFirstFrame) {
                this.receivedFirstFrame = true;
            }

            if (this.detectedCodec === 'av1') {
                this.decoder.decode(
                    new EncodedVideoChunk({
                        type: 'key',
                        timestamp: Number(pts),
                        data,
                    }),
                );
            } else {
                // Annex B (H.264 / H.265): prepend SPS/PPS/VPS parameter sets to keyframe chunk
                const fullData = new Uint8Array(this.configData.length + data.length);
                fullData.set(this.configData);
                fullData.set(data, this.configData.length);
                try {
                    this.decoder.decode(
                        new EncodedVideoChunk({
                            type: 'key',
                            timestamp: Number(pts),
                            data: fullData,
                        }),
                    );
                } catch (err) {
                    console.error('[WebCodecsPlayer] Keyframe decode exception:', err);
                }
            }
            return;
        }

        if (!this.receivedFirstFrame) return; // Skip delta frames before first keyframe

        try {
            this.decoder.decode(
                new EncodedVideoChunk({
                    type: isKeyframe ? 'key' : 'delta',
                    timestamp: Number(pts),
                    data,
                }),
            );
        } catch (err) {
            console.error('[WebCodecsPlayer] Delta frame decode exception:', err);
        }
    }

    /** Find offset of NALU with given type in Annex B stream. Returns -1 if not found. */
    private findNaluOffset(data: Uint8Array, naluType: number): number {
        return findNaluByHeader(data, (b) => (b & 0x1f) === naluType);
    }

    private parseConfig(data: Uint8Array): { codec: string; width?: number; height?: number } | null {
        // Try H.264 SPS anywhere in the config NAL stream
        const spsOffset = this.findNaluOffset(data, 7);
        if (spsOffset >= 0) {
            this.detectedCodec = 'h264';
            try {
                return WebCodecsPlayer.parseSPSCodecString(data.subarray(spsOffset));
            } catch (e) {
                console.error('[WebCodecsPlayer] parseSPSCodecString error:', e);
                return { codec: 'avc1.42E01E' };
            }
        }

        // Try H.265 (VPS/SPS)
        const hevcSpsOffset = this.findHevcNalu(data, HEVC_NAL_TYPE.SPS);
        if (hevcSpsOffset >= 0) {
            this.detectedCodec = 'h265';
            try {
                return parseHevcSPS(data.subarray(hevcSpsOffset));
            } catch (e) {
                console.error('[WebCodecsPlayer] parseHevcSPS error:', e);
                return { codec: 'hev1.1.6.L93.B0' };
            }
        }

        // Try AV1
        if (data.length >= 4) {
            const configRecord = parseAv1ConfigRecord(data);
            if (configRecord) {
                this.detectedCodec = 'av1';
                return { ...configRecord, width: 0, height: 0 };
            }
            if (obuType(data[0]!) === OBU_TYPE.SEQUENCE_HEADER) {
                this.detectedCodec = 'av1';
                return parseAv1SequenceHeader(data);
            }
        }

        return null;
    }

    private findStartCode(data: Uint8Array): number {
        return findFirstNaluOffset(data);
    }

    private findHevcNalu(data: Uint8Array, nalType: number): number {
        return findNaluByHeader(data, (b) => hevcNalType(b) === nalType);
    }

    /** Set fallback dimensions from stream metadata (used by AV1 which doesn't include dimensions in config). */
    public setMetadataSize(width: number, height: number): void {
        this.metadataWidth = width;
        this.metadataHeight = height;
    }

    protected scaleCanvas(width: number, height: number): void {
        const videoSize = new Size(width, height);
        let scale = 1;
        if (this.bounds && !this.bounds.intersect(videoSize).equals(videoSize)) {
            scale = Math.min(this.bounds.w / width, this.bounds.h / height);
        }
        const w = width * scale;
        const h = height * scale;
        const screenInfo = new ScreenInfo(new Rect(0, 0, width, height), new Size(w, h), 0);
        this.emit('input-video-resize', screenInfo);
        this.setScreenInfo(screenInfo);
        this.initCanvas(width, height);
        const ctx = this.tag.getContext('2d');
        if (ctx) {
            this.context = ctx;
        }
        if (scale !== 1) {
            this.tag.style.transform = `scale(${scale.toFixed(4)})`;
        } else {
            this.tag.style.transform = '';
        }
        this.tag.style.transformOrigin = 'top left';
    }

    /** Legacy decode path — not used with v3.x demuxer. */
    protected override decode(_data: Uint8Array): void {
        // No-op: v3.x uses pushVideoFrame() instead
    }

    protected override drawDecoded = (): void => {
        if (this.receivedFirstFrame) {
            const data = this.decodedFrames.shift();
            if (data) {
                const frame: VideoFrame = data.frame;
                const cw = this.tag.width || frame.displayWidth;
                const ch = this.tag.height || frame.displayHeight;
                try {
                    this.context.drawImage(frame, 0, 0, cw, ch);
                } catch (e) {
                    console.error('[WebCodecsPlayer] drawImage error:', e);
                }
                frame.close();
            }
        }
        if (this.decodedFrames.length) {
            this.animationFrameId = requestAnimationFrame(this.drawDecoded);
        } else {
            this.animationFrameId = undefined;
        }
    };

    protected override dropFrame(frame: VideoFrame): void {
        frame.close();
    }

    public override getFitToScreenStatus(): boolean {
        return false;
    }

    public override getPreferredVideoSetting(): VideoSettings {
        return WebCodecsPlayer.preferredVideoSettings;
    }

    public override loadVideoSettings(): VideoSettings {
        return WebCodecsPlayer.loadVideoSettings(this.udid, this.displayInfo);
    }

    protected override needScreenInfoBeforePlay(): boolean {
        return false;
    }

    public override stop(): void {
        super.stop();
        if (this.decoder.state === 'configured') {
            this.decoder.close();
        }
        this.decoder = this.createDecoder();
        this.configData = undefined;
        this.detectedCodec = null;
    }
}
