"""Shared bounded presentation drawing from validated local assets."""
import json
import math
import os
import sys
import unicodedata
from datetime import datetime, timezone, timedelta
from functools import lru_cache
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps

Image.MAX_IMAGE_PIXELS = 24_000_000
TZ = timezone(timedelta(hours=8))
INK = '#242632'
MUTED = '#858b96'
PINK = '#ec6b91'
BLUE = '#3690b3'
FONT_PATHS = ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc']
EMOJI_PATHS = ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', '/System/Library/Fonts/Apple Color Emoji.ttc']

@lru_cache(maxsize=24)
def font(size, bold=False):
    for path in FONT_PATHS:
        if not Path(path).is_file():
            continue
        candidate = path.replace('Regular.ttc', 'Bold.ttc') if bold else path
        if not Path(candidate).is_file():
            candidate = path
        return ImageFont.truetype(candidate, size, index=2 if path.startswith('/System/') and bold else 0)
    raise ValueError('PLUGIN_FONT_UNAVAILABLE')


def label(canvas, text, x, top, size=28, fill=INK, bold=False, max_width=None, emoji=False):
    if emoji:
        return emoji_label(canvas, text, x, top, size, fill, bold, max_width)
    f = font(size, bold)
    if max_width is not None:
        text = ' '.join(text.split())
        if f.getlength(text) > max_width:
            value = ''
            for c in clusters(text):
                if f.getlength(value + c + '…') > max_width:
                    break
                value += c
            text = value + '…'
    ImageDraw.Draw(canvas).text((x, top + f.getmetrics()[0]), text, font=f, fill=fill, anchor='ls')


def stamp(value):
    try:
        return datetime.fromtimestamp(value, TZ).strftime('%Y-%m-%d %H:%M') + ' UTC+8'
    except (ValueError, TypeError, OverflowError):
        return ''


def display_size(image):
    width, height = image.size
    if image.getexif().get(274) in (5, 6, 7, 8):
        return height, width
    return width, height


def clusters(text):
    result = []
    for c in text:
        skin_tone = 0x1f3fb <= ord(c) <= 0x1f3ff
        regional_pair = result and 0x1f1e6 <= ord(c) <= 0x1f1ff and len(result[-1]) == 1 and 0x1f1e6 <= ord(result[-1]) <= 0x1f1ff
        if result and (unicodedata.combining(c) or unicodedata.category(c) in ('Mc', 'Me') or skin_tone or regional_pair or c in '\ufe0e\ufe0f\u200d' or result[-1].endswith('\u200d')):
            result[-1] += c
        else:
            result.append(c)
    return result


@lru_cache(maxsize=64)
def emoji_picture(text, size):
    for path in EMOJI_PATHS:
        if not Path(path).is_file():
            continue
        try:
            f = ImageFont.truetype(path, 109 if 'Noto' in path else 64)
            image = Image.new('RGBA', (192, 192))
            ImageDraw.Draw(image).text((0, 0), text, font=f, embedded_color=True, anchor='lt')
            if image.getbbox():
                image = image.crop(image.getbbox())
                image.thumbnail((size, size), Image.Resampling.LANCZOS)
                return image
        except (OSError, ValueError):
            pass
    return None


def emoji_label(canvas, text, x, top, size, fill, bold, max_width):
    f = font(size, bold)
    tokens = []
    for token in clusters(' '.join(text.split())):
        picture = emoji_picture(token, size+2) if any(ord(c) > 0x1f000 for c in token) else None
        tokens.append((token, picture, size+4 if picture else f.getlength(token)))
    if not any(picture for _, picture, _ in tokens):
        return label(canvas, text, x, top, size, fill, bold, max_width)
    ellipsis = f.getlength('…')
    if max_width is not None and sum(width for _, _, width in tokens) > max_width:
        kept, used = [], 0
        for token in tokens:
            if used + token[2] + ellipsis > max_width:
                break
            kept.append(token)
            used += token[2]
        tokens = kept + [('…', None, ellipsis)]
    baseline = top + f.getmetrics()[0]
    draw = ImageDraw.Draw(canvas)
    for text, picture, width in tokens:
        if picture:
            canvas.paste(picture, (round(x), round(baseline-size+(size-picture.height)/2)), picture)
        else:
            draw.text((round(x), baseline), text, font=f, fill=fill, anchor='ls')
        x += width


class Renderer:
    error_prefix = 'PLUGIN'
    brand_name = ''
    brand_color = INK
    brand_size = 25
    brand_top = 40
    heading_x = 210
    accent_segments = ()
    fallback_author = ''
    author_emoji = False

    def __init__(self, request, root):
        self.content = request['content']
        self.root = root.resolve()
        self.paths = request.get('paths', {})
        self.max_pages = min(3, int(request.get('maxPages', 3)))
        self.items = []
        self.image_count = 0

    def local(self, ref):
        path = self.paths.get(ref.get('assetKey', ''))
        if not path:
            return None
        p = Path(path).resolve()
        if p.parent != self.root or not p.is_file() or Path(path).is_symlink():
            raise ValueError(self.error_prefix + '_IMAGE_PATH_REJECTED')
        return p

    def picture(self, ref, indent=0, max_height=4500):
        path = self.local(ref)
        if path is None:
            return
        with Image.open(path) as image:
            width, height = display_size(image)
        if width * height > Image.MAX_IMAGE_PIXELS or width < 1 or height < 1:
            raise ValueError(self.error_prefix + '_IMAGE_LIMIT')
        target_w = 976 - indent * 2
        target_h = max(1, min(max_height, round(height * target_w / width)))
        target_w = max(1, min(target_w, round(width * target_h / height)))
        self.items.append({'kind': 'image', 'path': path, 'width': target_w, 'height': target_h + 20, 'indent': indent})
        self.image_count += 1

    def paragraph(self, text, spans=None, size=34, indent=0, color=INK, max_lines=None):
        first = len(self.items)
        tokens = []
        for span in spans or [{'type': 'text', 'text': text}]:
            if span.get('type') == 'emoji' and self.local(span):
                tokens.append({'kind': 'asset', 'path': self.local(span), 'width': size + 6})
            else:
                for c in clusters(span.get('text', '')):
                    is_emoji = any(ord(ch) > 0x1f000 for ch in c)
                    pic = emoji_picture(c, size + 2) if is_emoji else None
                    tokens.append({'kind': 'emoji' if pic else 'text', 'value': c, 'pic': pic, 'width': size + 4 if pic else font(size).getlength(c)})
        width = 976 - indent * 2
        line = []
        used = 0
        closing = '，。！？；：、）》】」』”’'
        for index, token in enumerate(tokens):
            if token.get('value') == '\n':
                self.items.append({'kind': 'line', 'tokens': line, 'size': size, 'height': size + 24, 'indent': indent, 'color': color})
                line, used = [], 0
                continue
            next_value = tokens[index + 1].get('value') if index + 1 < len(tokens) else None
            next_width = tokens[index + 1]['width'] if next_value and next_value in closing else 0
            if used and used + token['width'] + next_width > width:
                self.items.append({'kind': 'line', 'tokens': line, 'size': size, 'height': size + 24, 'indent': indent, 'color': color})
                line, used = [], 0
            line.append(token)
            used += token['width']
        if line:
            self.items.append({'kind': 'line', 'tokens': line, 'size': size, 'height': size + 24, 'indent': indent, 'color': color})
        if max_lines is not None and len(self.items) - first > max_lines:
            del self.items[first + max_lines:]
            last = self.items[-1]['tokens']
            ellipsis = {'kind': 'text', 'value': '…', 'width': font(size).getlength('…')}
            while last and sum(token['width'] for token in last) + ellipsis['width'] > width:
                last.pop()
            last.append(ellipsis)
        self.items.append({'kind': 'gap', 'height': 14, 'indent': indent})

    def draw_image(self, canvas, path, x, y, width, height=None, round_avatar=False):
        with Image.open(path) as original:
            original.draft('RGB', (max(width * 2, 64), max((height or width) * 2, 64)))
            p = ImageOps.exif_transpose(original)
            if round_avatar:
                p = p.convert('RGBA' if 'A' in p.getbands() or 'transparency' in p.info else 'RGB')
                p = ImageOps.fit(p, (width, width), method=Image.Resampling.LANCZOS)
            else:
                p = p.convert('RGBA' if p.mode == 'RGBA' else 'RGB')
                p = p.resize((width, height), Image.Resampling.LANCZOS) if height else p
            mask = Image.new('L', p.size)
            if round_avatar:
                ImageDraw.Draw(mask).ellipse((0, 0, width-1, width-1), fill=255)
            else:
                ImageDraw.Draw(mask).rounded_rectangle((0, 0, p.width-1, p.height-1), radius=10, fill=255)
            if p.mode == 'RGBA':
                mask = ImageChops.multiply(mask, p.getchannel('A')) if round_avatar else p.getchannel('A')
            canvas.paste(p, (x, y), mask)

    def video_document(self, caption_only=False, cover_max_height=720):
        c = self.content
        if caption_only:
            self.paragraph(c.get('description') or c.get('title') or '视频', size=34, max_lines=8)
        else:
            self.paragraph(c['title'], size=40, max_lines=4)
        cover = next((block['image'] for block in c.get('blocks', []) if block.get('type') == 'image' and block.get('image', {}).get('role') == 'cover'), None)
        if cover:
            self.picture(cover, max_height=cover_max_height)
        metadata = []
        seconds = c.get('durationSeconds')
        if isinstance(seconds, (int, float)) and math.isfinite(seconds) and seconds >= 0:
            seconds = math.ceil(seconds)
            hours, remaining = divmod(seconds, 3600)
            minutes, seconds = divmod(remaining, 60)
            metadata.append('时长 ' + (f'{hours:02}:{minutes:02}:{seconds:02}' if hours else f'{minutes:02}:{seconds:02}'))
        part = c.get('part')
        if not caption_only and isinstance(part, int) and part > 1:
            metadata.append(f'P{part}')
        if metadata:
            self.paragraph(' · '.join(metadata), size=25, color=MUTED, max_lines=1)
        if not caption_only and c.get('description'):
            self.paragraph(c['description'], size=30, max_lines=6)

    def pages(self):
        pages = [[]]
        used = 0
        for item in self.items:
            if used + item['height'] > 5300 and pages[-1]:
                pages.append([])
                used = 0
            pages[-1].append(item)
            used += item['height']
        if len(pages) > self.max_pages:
            raise ValueError(self.error_prefix + '_RENDER_LIMIT')
        return pages

    def heading(self):
        return '视频分享'

    def author_subtitle(self):
        return stamp(self.content.get('publishedAt'))

    def draw_author(self, canvas):
        avatar = self.local(self.content.get('authorAvatar', {}))
        if avatar:
            self.draw_image(canvas, avatar, 52, 116, 76, round_avatar=True)
        x = 147 if avatar else 52
        name = ' '.join((self.content.get('author') or '').split()) or self.fallback_author
        label(canvas, name, x, 116, 32, INK, True, max_width=1028-x, **({'emoji': True} if self.author_emoji else {}))
        sub = self.author_subtitle()
        label(canvas, sub, x, 162, 22, MUTED, max_width=1028-x)

    def render(self):
        pages = self.plan()
        names = []
        for page_index, items in enumerate(pages):
            h = 270 + sum(item['height'] for item in items) + 180
            canvas = Image.new('RGB', (1080, h), 'white')
            d = ImageDraw.Draw(canvas)
            d.rectangle((0, 0, 1079, 7), fill=self.brand_color)
            for start, end, color in self.accent_segments:
                d.rectangle((start, 0, end, 7), fill=color)
            label(canvas, self.brand_name, 52, self.brand_top, self.brand_size, self.brand_color, True)
            video = self.content['type'] == 'video'
            label(canvas, self.heading(), self.heading_x, 43, 22, MUTED)
            self.draw_author(canvas)
            y = 235
            for item in items:
                indent = item.get('indent', 0)
                if indent:
                    d.rectangle((52, y, 1028, y + item['height']), fill='#f6f7f9')
                x = 52 + indent
                if item['kind'] == 'line':
                    size = item['size']
                    baseline = y + (item['height'] - size) // 2 + font(size).getmetrics()[0]
                    for token in item['tokens']:
                        if token['kind'] == 'text':
                            d.text((round(x), baseline), token['value'], font=font(size), fill=item['color'], anchor='ls')
                        else:
                            if token['kind'] == 'asset':
                                with Image.open(token['path']) as source:
                                    p = source.convert('RGBA');p.thumbnail((size+6, size+6), Image.Resampling.LANCZOS)
                            else:
                                p = token['pic']
                            canvas.paste(p, (round(x), round(baseline - size + (size-p.height)/2)), p)
                        x += token['width']
                elif item['kind'] == 'image':
                    target_h = item['height'] - 20
                    self.draw_image(canvas, item['path'], round(52+(976-item['width'])/2), y, item['width'], target_h)
                y += item['height']
            y += 20
            d.line((52, y, 1028, y), fill='#e9ebef', width=2)
            label(canvas, '原视频链接' if video else '原文链接', 52, y+24, 20, MUTED)
            label(canvas, self.content['url'], 52, y+60, 23, BLUE, max_width=976 if video else None)
            if len(pages) > 1:
                label(canvas, f'{page_index+1} / {len(pages)}', 940, y+100, 20, MUTED)
            name = f'card-{page_index}.png'
            canvas.save(self.root/name, compress_level=4)
            names.append(name)
        return names


def run_cli(renderer, error_prefix):
    os.umask(0o077)
    if sys.argv[1] == 'inspect':
        path = Path(sys.argv[2])
        with Image.open(path) as im:
            width, height = display_size(im)
            if im.format not in ('JPEG', 'PNG', 'GIF', 'WEBP') or width < 1 or height < 1 or width * height > int(sys.argv[3]):
                raise ValueError(error_prefix + '_IMAGE_LIMIT')
            im.verify()
        print(json.dumps({'width': width, 'height': height}))
    elif sys.argv[1] == 'render':
        source = Path(sys.argv[2]).resolve()
        if source.stat().st_size > 1024*1024:
            raise ValueError(error_prefix + '_RENDER_LIMIT')
        request = json.loads(source.read_text())
        print(json.dumps({'files': renderer(request, source.parent).render()}))
    else:
        raise ValueError(error_prefix + '_RENDER_INVALID')
