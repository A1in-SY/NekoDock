"""Render a bounded game card using validated local assets and structured game data."""
import json
import sys
import unicodedata
import warnings
from datetime import datetime, timezone, timedelta
from functools import lru_cache
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

MAX_PIXELS = 24_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
warnings.simplefilter('error', Image.DecompressionBombWarning)
FONT_PATHS = ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc']
EMOJI_PATHS = ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', '/System/Library/Fonts/Apple Color Emoji.ttc']
INK, MUTED, GREEN = '#233b35', '#73847c', '#39775b'


@lru_cache(maxsize=20)
def font(size, bold=False):
    for path in FONT_PATHS:
        if Path(path).is_file():
            candidate = path.replace('Regular.ttc', 'Bold.ttc') if bold else path
            if not Path(candidate).is_file():
                candidate = path
            return ImageFont.truetype(candidate, size, index=2 if path.startswith('/System/') and bold else 0)
    raise ValueError('HEYBOX_FONT_UNAVAILABLE')


def clusters(text):
    groups = []
    for char in text:
        paired_flag = groups and 0x1f1e6 <= ord(char) <= 0x1f1ff and len(groups[-1]) == 1 and 0x1f1e6 <= ord(groups[-1]) <= 0x1f1ff
        if groups and (unicodedata.combining(char) or unicodedata.category(char) in ('Mc', 'Me') or char in '\ufe0e\ufe0f\u200d' or groups[-1].endswith('\u200d') or 0x1f3fb <= ord(char) <= 0x1f3ff or paired_flag):
            groups[-1] += char
        else:
            groups.append(char)
    return groups


@lru_cache(maxsize=48)
def emoji(text, size):
    for path in EMOJI_PATHS:
        if not Path(path).is_file():
            continue
        try:
            f = ImageFont.truetype(path, 109 if 'Noto' in path else 64)
            image = Image.new('RGBA', (256, 256))
            ImageDraw.Draw(image).text((0, 0), text, font=f, embedded_color=True, anchor='lt')
            if image.getbbox():
                image = image.crop(image.getbbox())
                image.thumbnail((size, size), Image.Resampling.LANCZOS)
                return image
        except (OSError, ValueError):
            pass
    return None


def units(text, size, bold=False):
    f = font(size, bold)
    out = []
    for cluster in clusters(text):
        picture = emoji(cluster, size) if any(ord(char) >= 0x1f000 or 0x2600 <= ord(char) <= 0x27ff for char in cluster) else None
        out.append((cluster, max(1, size if picture else f.getlength(cluster)), picture))
    return out


def wrapped(text, size, width, max_lines, bold=False):
    lines, line, used = [], [], 0
    for value in units(str(text)[:12000], size, bold):
        if value[0] == '\n' or line and used + value[1] > width:
            lines.append(line)
            if len(lines) == max_lines:
                if value[0] != '\n':
                    while lines[-1] and sum(x[1] for x in lines[-1]) + font(size, bold).getlength('…') > width:
                        lines[-1].pop()
                    lines[-1].append(('…', font(size, bold).getlength('…'), None))
                return lines
            line, used = [], 0
            if value[0] == '\n':
                continue
        line.append(value)
        used += value[1]
    if line:
        lines.append(line)
    return lines[:max_lines]


def draw_lines(canvas, lines, top, size, fill=INK, bold=False, x=52):
    f = font(size, bold)
    for line in lines:
        baseline, left = top + f.getmetrics()[0], x
        for text, width, picture in line:
            if picture:
                canvas.paste(picture, (round(left), round(baseline - size + (size - picture.height) / 2)), picture)
            else:
                ImageDraw.Draw(canvas).text((left, baseline), text, font=f, fill=fill, anchor='ls')
            left += width
        top += int(size * 1.5)
    return top


def image_info(path):
    with Image.open(path) as image:
        width, height = image.size
        if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
            raise ValueError('HEYBOX_IMAGE_LIMIT')
        if image.getexif().get(274) in (5, 6, 7, 8):
            width, height = height, width
        return {'width': width, 'height': height}


def render(request_path):
    request_path = Path(request_path).resolve()
    if request_path.stat().st_size > 256 * 1024:
        raise ValueError('HEYBOX_RENDER_LIMIT')
    request = json.loads(request_path.read_text())
    content, root = request['content'], request_path.parent
    if content.get('type') != 'game' or not isinstance(content.get('game'), dict):
        raise ValueError('HEYBOX_RENDER_INVALID')
    game = content['game']
    blocks = []
    blocks.append((str(content.get('title', ''))[:500], 44, INK, True, 3))
    if game.get('nameEnglish'):
        blocks.append((game['nameEnglish'], 25, MUTED, False, 2))
    platform = game.get('platformName') or {'pc': 'PC', 'console': '主机', 'mobile': '手机'}.get(game.get('gameType'), '')
    if platform:
        blocks.append((platform, 28, GREEN, True, 2))
    score = game.get('score')
    if score:
        label = f"{score.get('source', '小黑盒')}评分  {score['value']:g} / {score['scale']:g}"
        if score.get('count') is not None:
            label += f"  ·  {score['count']:g} 人评价"
        blocks.append((label, 32, GREEN, True, 2))
    if game.get('isFree'):
        blocks.append(('免费游玩', 30, GREEN, True, 1))
    if request.get('showPrices', True):
        for price in game.get('prices', [])[:4]:
            label = f"{price['label']}  {price.get('currency', '')} {price['current']}".strip()
            if price.get('region'):
                label += f"  ·  {price['region']}"
            if price.get('discountPercent'):
                label += f"  ·  优惠 {price['discountPercent']:g}%"
            blocks.append((label, 29, INK, True, 2))
            if price.get('recordedLowest') is not None:
                blocks.append((f"小黑盒记录史低 · 该平台  {price['recordedLowest']}", 24, MUTED, False, 2))
            if price.get('condition'):
                blocks.append((price['condition'], 24, MUTED, False, 3))
    for label, key in [('发行时间', 'releaseDate'), ('开发商', 'developers'), ('发行商', 'publishers')]:
        value = game.get(key)
        if value:
            blocks.append((label + '：' + ('、'.join(value) if isinstance(value, list) else value), 25, MUTED, False, 2))
    if game.get('platforms'):
        blocks.append(('游戏平台：' + ' / '.join(dict.fromkeys(p['name'] for p in game['platforms'])), 25, MUTED, False, 2))
    if game.get('tags'):
        blocks.append((' · '.join(game['tags']), 24, GREEN, False, 3))
    if content.get('description'):
        blocks.append(('简介', 28, INK, True, 1))
        blocks.append((content['description'], 27, INK, False, 9))
    prepared = [(wrapped(text, size, 976, maximum, bold), size, color, bold) for text, size, color, bold, maximum in blocks]
    cover = None
    if request.get('cover'):
        name = request['cover']
        if not isinstance(name, str) or Path(name).name != name:
            raise ValueError('HEYBOX_IMAGE_PATH_REJECTED')
        path = root / name
        if path.is_symlink() or path.resolve().parent != root:
            raise ValueError('HEYBOX_IMAGE_PATH_REJECTED')
        image_info(path)
        with Image.open(path) as image:
            if image.format == 'JPEG':
                image.draft('RGB', (1952, 1000))
            cover = ImageOps.exif_transpose(image).convert('RGB')
            cover = ImageOps.fit(cover, (976, 450), method=Image.Resampling.LANCZOS)
    y = 110 + (480 if cover else 0)
    height = y + sum(int(size * 1.5) * len(lines) + 18 for lines, size, _, _ in prepared) + 125
    if height > 3800:
        raise ValueError('HEYBOX_RENDER_LIMIT')
    canvas = Image.new('RGB', (1080, height), '#f6f8f5')
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((24, 24, 1056, height - 24), radius=24, fill='#ffffff')
    draw_lines(canvas, wrapped('HEYBOX  ·  游戏分享', 26, 976, 1, True), 46, 26, GREEN, True)
    if cover:
        canvas.paste(cover, (52, 110))
    for lines, size, color, bold in prepared:
        y = draw_lines(canvas, lines, y, size, color, bold) + 18
    draw.line((52, height - 104, 1028, height - 104), fill='#e4ebe5', width=2)
    stamp = ''
    try:
        stamp = datetime.fromtimestamp(content.get('observedAt', 0), timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M') + ' UTC+8'
    except (ValueError, TypeError, OverflowError):
        pass
    draw_lines(canvas, wrapped('资料来源：小黑盒  ·  ' + stamp, 21, 976, 1), height - 82, 21, MUTED)
    canvas.save(root / 'card.png', optimize=False, compress_level=4)
    return {'file': 'card.png'}


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ('inspect', 'render'):
        raise ValueError('HEYBOX_RENDER_INVALID')
    print(json.dumps(image_info(sys.argv[2]) if sys.argv[1] == 'inspect' else render(sys.argv[2]), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__, file=sys.stderr)
        sys.exit(1)
