#!/usr/bin/env python3
"""Decode an image file with libheif (through pillow-heif) and write out everything it holds, like
imageio-extract.swift does with macOS ImageIO, for servers that are not a Mac:
  - every top-level image ("frame"; a HEIC can hold several) as an upright JPEG,
  - the depth or disparity map of the primary photo (float32 plus a preview PNG) and the portrait /
    semantic segmentation mattes Apple cameras store with it (PNG), upright like the photo.
Prints the same JSON description on stdout. Used by the WOM server for HEIC/HEIF uploads.

  libheif-extract.py <input> <output dir> [--thumbs <max px>] [--max-pixels <n>]

Exit status: 0 done, 1 file unreadable, 2 usage, 3 pillow-heif missing, 4 image larger than --max-pixels.
Needs: pip install pillow-heif (it bundles libheif and the libde265 HEVC decoder).
"""
import array
import json
import mmap
import os
import re
import sys


def die(code, message):
    sys.stderr.write(message.strip() + '\n')
    sys.exit(code)


try:
    import pillow_heif
    from PIL import Image
except ImportError as err:
    die(3, 'pillow-heif is not installed (%s). Run: pip install pillow-heif' % err)

# libheif has already applied the rotation, mirroring and cropping the file asks for, and it applies
# them to the depth map and mattes too, so everything written here is upright.
APPLE_MATTES = {
    'portraiteffectsmatte': 'portrait-matte',
    'semanticskymatte': 'sky-matte',
    'semantichairmatte': 'hair-matte',
    'semanticskinmatte': 'skin-matte',
    'semanticteethmatte': 'teeth-matte',
    'semanticglassesmatte': 'glasses-matte',
}
# depth_representation_type of the depth_representation_info the file carries (ITU-T H.265)
UNIFORM_DISPARITY, UNIFORM_Z = 1, 2


def option(args, name):
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            try:
                return int(args[i + 1])
            except ValueError:
                die(2, '%s needs a whole number' % name)
    return 0


def printable(text, limit=80):
    """A value taken from the file, made safe to put in a note."""
    return ''.join(c if 32 <= ord(c) < 127 else '?' for c in str(text))[:limit]


def is_complete(path):
    """False for a file that ends inside its meta or mdat box (an interrupted copy or upload).
    libheif still decodes such a file: libde265 guesses what is missing, so most of the picture is wrong.
    Boxes name their own size, which makes a cut file easy to see. Anything else is left to libheif."""
    size = os.path.getsize(path)
    offset = 0
    with open(path, 'rb') as f:
        while offset + 8 <= size:
            f.seek(offset)
            head = f.read(16)
            box = int.from_bytes(head[:4], 'big')
            if box == 1 and len(head) == 16:
                box = int.from_bytes(head[8:16], 'big')
            elif box == 0:
                return True  # runs to the end of the file
            if box < 8:
                return True  # not a box layout this check understands
            if offset + box > size:
                return head[4:8] not in (b'meta', b'mdat')
            offset += box
    return True


def plain_rows(data, width_bytes, stride, height):
    data = bytes(data)
    if stride == width_bytes:
        return data[: width_bytes * height]
    return b''.join(data[y * stride : y * stride + width_bytes] for y in range(height))


def exif_for(info):
    """The file's EXIF with the orientation reset: libheif has already turned the pixels upright."""
    blob = info.get('exif')
    if not blob:
        return None
    try:
        exif = Image.Exif()
        exif.load(blob)
        for ifd in (0x8769, 0x8825):  # Exif and GPS sub-directories, loaded so they are written back
            try:
                exif.get_ifd(ifd)
            except Exception:
                pass
        exif[0x0112] = 1
        return exif
    except Exception:
        return None


def depth_flags(path):
    """Apple keeps accuracy, quality and filtering of a depth map as XMP in the file (depthData: tags).
    Returns the values only when each tag appears exactly once, so it is clear which map they describe."""
    found = {}
    with open(path, 'rb') as f:
        try:
            data = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        except ValueError:
            return found, False
        try:
            for key in ('Accuracy', 'Quality', 'Filtered'):
                pattern = rb'<depthData:%s>\s*([A-Za-z]+)\s*</depthData:%s>' % (key.encode(), key.encode())
                found[key] = [m.group(1).decode('ascii').lower() for m in re.finditer(pattern, data)]
        finally:
            data.close()
    return found, all(len(v) == 1 for v in found.values())


def depth_entry(depth, flags, flags_ok, out_dir, notes):
    """One depth or disparity map as float32 (metres or 1/metre) plus an 8-bit preview, near = bright."""
    meta = depth.info.get('metadata') or {}
    kind = meta.get('representation_type')
    if kind == UNIFORM_Z and 'z_near' in meta and 'z_far' in meta:
        label, first, last = 'depth', meta['z_near'], meta['z_far']
    elif kind == UNIFORM_DISPARITY and 'd_min' in meta and 'd_max' in meta:
        label, first, last = 'disparity', meta['d_min'], meta['d_max']
    else:
        notes.append('depth map %d uses representation %s, which is not supported' % (index, kind))
        return None
    w, h = depth.size
    if depth.mode == 'L':
        levels, per_px, typecode = 255, 1, 'B'
    elif depth.mode.startswith('I;16'):
        levels, per_px, typecode = 65535, 2, 'H'
    else:
        notes.append('%s map has pixel mode %s, which is not supported' % (label, depth.mode))
        return None
    rows = plain_rows(depth.data, w * per_px, depth.stride, h)
    codes = array.array(typecode)
    codes.frombytes(rows)
    if sys.byteorder == 'big' and per_px == 2:
        codes.byteswap()  # libheif hands over little-endian samples
    step = (last - first) / levels
    table = [first + c * step for c in range(levels + 1)]
    values = array.array('f', map(table.__getitem__, codes))
    lo, hi = table[min(codes)], table[max(codes)]
    name = 'aux-%s' % label
    with open(os.path.join(out_dir, name + '.f32'), 'wb') as f:
        if sys.byteorder == 'big':
            values.byteswap()
        values.tofile(f)
    preview = None
    if hi > lo:
        scale = 255.0 / (hi - lo)
        near_is_high = label == 'disparity'
        shade = [int(max(0, min(255, ((v - lo) * scale if near_is_high else 255 - (v - lo) * scale)))) for v in table]
        gray = bytes(shade[c] for c in codes) if per_px == 2 else rows.translate(bytes(shade[c] if c < len(shade) else 0 for c in range(256)))
        Image.frombytes('L', (w, h), gray).save(os.path.join(out_dir, name + '.png'))
        preview = name + '.png'
    entry = {'type': label, 'width': w, 'height': h, 'file': name + '.f32', 'preview': preview, 'min': lo, 'max': hi}
    if flags_ok:
        accuracy, quality = flags['Accuracy'][0], flags['Quality'][0]
        if accuracy in ('absolute', 'relative'):
            entry['accuracy'] = accuracy
        if quality in ('high', 'low'):
            entry['quality'] = quality
        entry['filtered'] = flags['Filtered'][0] == 'true'
    return entry


def without_none(value):
    """The JSON leaves out what is not known, like the Swift helper's encoder does."""
    if isinstance(value, dict):
        return {k: without_none(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [without_none(v) for v in value]
    return value


def main(args):
    if len(args) < 2 or args[0].startswith('--'):
        die(2, 'usage: libheif-extract.py <input> <output dir> [--thumbs <max px>] [--max-pixels <n>]')
    src, out_dir = args[0], args[1]
    thumb_px, max_pixels = option(args, '--thumbs'), option(args, '--max-pixels')
    os.makedirs(out_dir, exist_ok=True)

    if not is_complete(src):
        die(1, 'the file is incomplete: it ends before the picture data does')
    try:
        heif = pillow_heif.open_heif(src)
    except Exception as err:
        die(1, 'libheif cannot open the file: %s' % printable(err, 200))
    if len(heif) == 0:
        die(1, 'the file holds no image')
    primary = heif.primary_index
    notes = []

    # 1. Every top-level image.
    frames = []
    for i, image in enumerate(heif):
        w, h = image.size
        if max_pixels and w * h > max_pixels:
            die(4, 'the image is %dx%d, more than %d pixels' % (w, h, max_pixels))
        try:
            pil = image.to_pillow()
            if pil.mode != 'RGB':
                pil = pil.convert('RGB')
        except Exception as err:
            notes.append('frame %d could not be decoded (%s)' % (i, printable(err)))
            continue
        options = {'quality': 95}
        exif = exif_for(image.info)
        if exif is not None:
            options['exif'] = exif
        icc = image.info.get('icc_profile')
        if icc:
            options['icc_profile'] = icc
        elif i == primary and (image.info.get('nclx_profile') or {}).get('color_primaries') not in (None, 1, 2):
            notes.append('colour is described by nclx primaries %s and no ICC profile; it is treated as sRGB' % image.info['nclx_profile']['color_primaries'])
        name = 'frame-%d.jpg' % i
        try:
            pil.save(os.path.join(out_dir, name), 'JPEG', **options)
        except Exception:
            options.pop('exif', None)  # an EXIF block Pillow cannot write back; the server reads the original's EXIF itself
            pil.save(os.path.join(out_dir, name), 'JPEG', **options)
        entry = {'index': i, 'width': pil.width, 'height': pil.height, 'orientation': 1, 'file': name, 'thumb': None}
        if thumb_px > 0:
            pil.thumbnail((thumb_px, thumb_px), Image.Resampling.LANCZOS)  # the full-size JPEG is already written
            thumb = 'thumb-%d.jpg' % i
            pil.save(os.path.join(out_dir, thumb), 'JPEG', quality=85)
            entry['thumb'] = thumb
        frames.append(entry)
        del pil
    if not frames:
        die(1, 'the file holds no readable image')

    # 2. Auxiliary images of the primary photo.
    aux = []
    info = heif[primary].info
    depth_maps = info.get('depth_images') or []
    flags, flags_ok = depth_flags(src) if depth_maps else ({}, False)
    flags_ok = flags_ok and len(depth_maps) == 1
    if depth_maps and not flags_ok and any(flags.values()):
        notes.append('the file has %d depth maps and %d accuracy tags; accuracy and quality are not assigned' % (len(depth_maps), len(flags['Accuracy'])))
    for depth in depth_maps:
        entry = depth_entry(depth, flags, flags_ok, out_dir, notes)
        if entry:
            aux.append(entry)
    for urn, ids in (info.get('aux') or {}).items():
        suffix = urn.rsplit(':', 1)[-1].lower()
        if suffix == 'hdrgainmap':
            aux.append({'type': 'hdr-gain-map', 'width': 0, 'height': 0, 'file': None, 'preview': None})
            continue
        label = APPLE_MATTES.get(suffix)
        if not label:
            notes.append('auxiliary image %s is not recognised' % printable(urn))
            continue
        try:
            matte = heif.get_aux_image(ids[0]) if hasattr(heif, 'get_aux_image') else heif[primary].get_aux_image(ids[0])
            pil = matte.to_pillow()
            pil = pil.convert('L')
            name = 'aux-%s.png' % label
            pil.save(os.path.join(out_dir, name))
            aux.append({'type': label, 'width': pil.width, 'height': pil.height, 'file': name, 'preview': name})
        except Exception as err:
            notes.append('%s present but could not be read (%s)' % (label, printable(err)))

    out = {'uti': heif.mimetype, 'count': len(heif), 'primaryIndex': primary, 'frames': frames, 'aux': aux, 'notes': notes}
    sys.stdout.write(json.dumps(without_none(out), sort_keys=True))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as err:  # the server shows the last line of stderr to the user, so keep paths out of it
        die(1, 'unexpected error while reading the file (%s)' % type(err).__name__)
