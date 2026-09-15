#!/usr/bin/env python3
"""Isolated, bounded decoder. Stdin is image data; stdout is metadata LF PNG."""
import io
import json
import resource
import sys
import warnings

resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))


class Refused(Exception):
    pass


def main():
    try:
        suffix, dimension, pixels, byte_limit = sys.argv[1:]
        dimension, pixels, byte_limit = int(dimension), int(pixels), int(byte_limit)
        if not (0 < dimension <= 8192 and 0 < pixels <= 16 * 1024 * 1024
                and 0 < byte_limit <= 8 * 1024 * 1024):
            raise Refused("image_dimension_limit")
        from PIL import Image, ImageOps, __version__
        if __version__ != "12.3.0":
            raise Refused("image_codec_unavailable")
        Image.MAX_IMAGE_PIXELS = pixels
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        data = sys.stdin.buffer.read(byte_limit + 1)
        if len(data) > byte_limit:
            raise Refused("image_file_limit")
        with Image.open(io.BytesIO(data)) as image:
            expected = {".png": "PNG", ".webp": "WEBP", ".ico": "ICO"}.get(suffix)
            if image.format != expected:
                raise Refused("image_format_mismatch")
            width, height = image.size
            if max(width, height) > dimension or width * height > pixels:
                raise Refused("image_dimension_limit")
            if getattr(image, "n_frames", 1) != 1 or (image.format == "ICO" and len(image.ico.entry) != 1):
                raise Refused("image_frame_limit")
            image.load()  # No first-frame fallback or truncated-image opt-in.
            metadata = {"source_format": image.format, "source_width": width,
                        "source_height": height, "frames": 1, "decoder": "Pillow-12.3.0"}
            if image.format == "PNG":
                rendered = data
            else:
                rgba = ImageOps.exif_transpose(image).convert("RGBA")
                profile = image.info.get("icc_profile")
                rgba.info.clear()

                class BoundedOutput(io.BytesIO):
                    def write(self, value):
                        if self.tell() + len(value) > byte_limit:
                            raise Refused("image_output_limit")
                        return super().write(value)

                output = BoundedOutput()
                rgba.save(output, "PNG", icc_profile=profile)
                rendered = output.getvalue()
        sys.stdout.buffer.write(json.dumps(metadata).encode() + b"\n" + rendered)
        return 0
    except Refused as error:
        code = str(error)
    except ImportError:
        code = "image_codec_unavailable"
    except Exception:
        code = "image_decode_failed"
    sys.stdout.buffer.write(json.dumps({"error": code}).encode() + b"\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
