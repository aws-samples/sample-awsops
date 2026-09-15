#!/usr/bin/env python3
"""Isolated, bounded decoder. Stdin is image data; stdout is metadata LF PNG."""
import io
import json
from pathlib import Path
import resource
import struct
import sys
import warnings

resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))


class Refused(Exception):
    pass


def main():
    bomb_errors = ()
    try:
        suffix, dimension, pixels, byte_limit = sys.argv[1:]
        dimension, pixels, byte_limit = int(dimension), int(pixels), int(byte_limit)
        if not (0 < dimension <= 8192 and 0 < pixels <= 16 * 1024 * 1024
                and 0 < byte_limit <= 8 * 1024 * 1024):
            raise Refused("image_dimension_limit")
        from PIL import Image, ImageOps, __version__
        bomb_errors = (Image.DecompressionBombWarning, Image.DecompressionBombError)
        if __version__ != "12.3.0":
            raise Refused("image_codec_unavailable")
        Image.MAX_IMAGE_PIXELS = pixels
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        data = sys.stdin.buffer.read(byte_limit + 1)
        if len(data) > byte_limit:
            raise Refused("image_file_limit")
        expected = json.loads(Path(__file__).with_name("image-formats.json").read_text()).get(suffix)
        if expected not in ("PNG", "WEBP", "ICO"):
            raise Refused("image_format_mismatch")
        with Image.open(io.BytesIO(data), formats=[expected]) as image:
            if image.format != expected:
                raise Refused("image_format_mismatch")
            width, height = image.size
            if max(width, height) > dimension or width * height > pixels:
                raise Refused("image_dimension_limit")
            if getattr(image, "n_frames", 1) != 1 or (image.format == "ICO" and len(image.ico.entry) != 1):
                raise Refused("image_frame_limit")
            image.load()  # No first-frame fallback or truncated-image opt-in.
            # ICO can replace its directory dimensions with the embedded rendition.
            width, height = image.size
            if max(width, height) > dimension or width * height > pixels:
                raise Refused("image_dimension_limit")
            metadata = {"source_format": image.format, "source_width": width,
                        "source_height": height, "frames": 1, "decoder": "Pillow-12.3.0"}
            if image.format == "PNG":
                offset = 8
                while offset + 12 <= len(data):
                    length, kind = struct.unpack(">I4s", data[offset:offset + 8])
                    offset += length + 12
                    if offset > len(data):
                        raise Refused("image_decode_failed")
                    if kind == b"IEND":
                        if length:
                            raise Refused("image_decode_failed")
                        break
                else:
                    raise Refused("image_decode_failed")
                rendered = data[:offset]
                rendered_size = image.size
            else:
                rgba = ImageOps.exif_transpose(image).convert("RGBA")
                rendered_size = rgba.size
                if max(rendered_size) > dimension or rendered_size[0] * rendered_size[1] > pixels:
                    raise Refused("image_dimension_limit")
                profile = image.info.get("icc_profile")
                if profile is not None and (not isinstance(profile, bytes) or len(profile) > 65536):
                    raise Refused("image_profile_limit")
                rgba.info.clear()

                class BoundedOutput(io.BytesIO):
                    def write(self, value):
                        if self.tell() + len(value) > byte_limit:
                            raise Refused("image_output_limit")
                        return super().write(value)

                output = BoundedOutput()
                rgba.save(output, "PNG", icc_profile=profile)
                rendered = output.getvalue()
            metadata.update(rendered_width=rendered_size[0], rendered_height=rendered_size[1])
        sys.stdout.buffer.write(json.dumps(metadata).encode() + b"\n" + rendered)
        return 0
    except Refused as error:
        code = str(error)
    except ImportError:
        code = "image_codec_unavailable"
    except bomb_errors:
        code = "image_dimension_limit"
    except Exception:
        code = "image_decode_failed"
    sys.stdout.buffer.write(json.dumps({"error": code}).encode() + b"\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
