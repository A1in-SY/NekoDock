"""Render bounded Bilibili presentation cards from validated local assets."""
import json
import math
import os
import sys
import unicodedata
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from functools import lru_cache
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

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
    raise ValueError('BILIBILI_FONT_UNAVAILABLE')


def label(canvas, text, x, top, size=28, fill=INK, bold=False):
    f = font(size, bold)
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


class Renderer:
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
            raise ValueError('BILIBILI_IMAGE_PATH_REJECTED')
        return p

    def picture(self, ref, indent=0):
        path = self.local(ref)
        if path is None:
            return
        with Image.open(path) as image:
            width, height = display_size(image)
        if width * height > Image.MAX_IMAGE_PIXELS or width < 1 or height < 1:
            raise ValueError('BILIBILI_IMAGE_LIMIT')
        target_w = 976 - indent * 2
        target_h = min(4500, round(height * target_w / width))
        target_w = min(target_w, round(width * target_h / height))
        self.items.append({'kind': 'image', 'path': path, 'width': target_w, 'height': target_h + 20, 'indent': indent})
        self.image_count += 1

    def paragraph(self, text, spans=None, size=34, indent=0, color=INK):
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
        self.items.append({'kind': 'gap', 'height': 14, 'indent': indent})

    def document(self, content, indent=0, title=True):
        if title and content.get('title') and not content['title'].endswith('的动态') and content['title'] != '哔哩哔哩动态':
            self.paragraph(content['title'], size=40, indent=indent)
        for b in content.get('blocks', []):
            if b['type'] == 'paragraph':
                self.paragraph(b['text'], b.get('spans'), indent=indent)
            elif b['type'] == 'image':
                self.picture(b['image'], indent)
            elif b['type'] == 'resource':
                self.paragraph((b.get('title') or '分享内容') + '\n' + b['resource']['url'], size=26, indent=indent, color=BLUE)
        original = content.get('original')
        if original:
            self.items.append({'kind': 'gap', 'height': 18, 'indent': 24})
            self.paragraph('转发自 ' + original.get('author', '原作者'), size=28, indent=24, color=MUTED)
            if original.get('publishedAt'):
                self.paragraph(stamp(original['publishedAt']), size=21, indent=24, color=MUTED)
            self.document(original, indent=24)
            self.items.append({'kind': 'gap', 'height': 18, 'indent': 24})

    def plan(self):
        c = self.content
        if c['type'] == 'live':
            self.paragraph(c['title'], size=41)
            live = c.get('live', {})
            status = {'live': '直播中', 'offline': '未开播', 'replay': '轮播中'}[live['status']]
            self.paragraph(' · '.join(filter(None, [status, live.get('parentArea'), live.get('area')])), size=25, color=MUTED)
            preview = live.get('preview', {})
            selected = preview if preview.get('status') == 'ready' else live.get('cover', {})
            self.picture(selected)
            role = '平台直播预览' if selected is preview else '直播间封面'
            self.paragraph(role, size=25)
            if selected.get('fetchedAt'):
                self.paragraph('获取时间：' + stamp(selected['fetchedAt']), size=22, color=MUTED)
            if selected.get('imageLastModified'):
                modified = parsedate_to_datetime(selected['imageLastModified']).astimezone(TZ).strftime('%H:%M:%S')
                self.paragraph('图片文件更新于 ' + modified + '，不等于画面拍摄时间', size=21, color=MUTED)
            if c.get('observedAt'):
                self.paragraph('资料获取时间：' + stamp(c['observedAt']), size=22, color=MUTED)
        else:
            self.document(c)
        if c.get('retrieval', {}).get('status') == 'partial':
            self.paragraph('部分资料或图片未能取得，以下内容以原分享为准。', size=23, color=MUTED)
        pages = [[]]
        used = 0
        for item in self.items:
            if used + item['height'] > 5300 and pages[-1]:
                pages.append([])
                used = 0
            pages[-1].append(item)
            used += item['height']
        if len(pages) > self.max_pages:
            raise ValueError('BILIBILI_RENDER_LIMIT')
        return pages

    def draw_image(self, canvas, path, x, y, width, height=None, round_avatar=False):
        with Image.open(path) as original:
            original.draft('RGB', (max(width * 2, 64), max((height or width) * 2, 64)))
            p = ImageOps.exif_transpose(original)
            if round_avatar:
                p = ImageOps.fit(p, (width, width), method=Image.Resampling.LANCZOS).convert('RGB')
            else:
                p = p.convert('RGBA' if p.mode == 'RGBA' else 'RGB')
                p = p.resize((width, height), Image.Resampling.LANCZOS) if height else p
            mask = Image.new('L', p.size)
            if round_avatar:
                ImageDraw.Draw(mask).ellipse((0, 0, width-1, width-1), fill=255)
            else:
                ImageDraw.Draw(mask).rounded_rectangle((0, 0, p.width-1, p.height-1), radius=10, fill=255)
            if p.mode == 'RGBA':
                mask = p.getchannel('A')
            canvas.paste(p, (x, y), mask)

    def render(self):
        pages = self.plan()
        names = []
        for page_index, items in enumerate(pages):
            h = 270 + sum(item['height'] for item in items) + 180
            canvas = Image.new('RGB', (1080, h), 'white')
            d = ImageDraw.Draw(canvas)
            d.rectangle((0, 0, 1079, 7), fill=PINK)
            label(canvas, 'BILIBILI', 52, 40, 25, PINK, True)
            label(canvas, '直播分享' if self.content['type'] == 'live' else '动态分享', 210, 43, 22, MUTED)
            avatar = self.local(self.content.get('authorAvatar', {}))
            if avatar:
                self.draw_image(canvas, avatar, 52, 116, 76, round_avatar=True)
            label(canvas, self.content.get('author') or '哔哩哔哩', 147 if avatar else 52, 116, 32, INK, True)
            sub = ('直播间 ' + self.content['live']['roomId']) if self.content['type'] == 'live' else stamp(self.content.get('publishedAt'))
            label(canvas, sub, 147 if avatar else 52, 162, 22, MUTED)
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
            label(canvas, '原文链接', 52, y+24, 20, MUTED)
            label(canvas, self.content['url'], 52, y+60, 23, BLUE)
            if len(pages) > 1:
                label(canvas, f'{page_index+1} / {len(pages)}', 940, y+100, 20, MUTED)
            name = f'card-{page_index}.png'
            canvas.save(self.root/name, compress_level=4)
            names.append(name)
        return names


def main():
    os.umask(0o077)
    if sys.argv[1] == 'inspect':
        path = Path(sys.argv[2])
        with Image.open(path) as im:
            width, height = display_size(im)
            if im.format not in ('JPEG', 'PNG', 'GIF', 'WEBP') or width < 1 or height < 1 or width * height > int(sys.argv[3]):
                raise ValueError('BILIBILI_IMAGE_LIMIT')
            im.verify()
        print(json.dumps({'width': width, 'height': height}))
    elif sys.argv[1] == 'render':
        source = Path(sys.argv[2]).resolve()
        if source.stat().st_size > 1024*1024:
            raise ValueError('BILIBILI_RENDER_LIMIT')
        request = json.loads(source.read_text())
        print(json.dumps({'files': Renderer(request, source.parent).render()}))
    else:
        raise ValueError('BILIBILI_RENDER_INVALID')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
