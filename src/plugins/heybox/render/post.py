"""Render bounded Heybox posts from validated local text and image assets."""
import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'plugin-system' / 'render'))
import nekodock_cards as shared


class Renderer(shared.Renderer):
    error_prefix = 'HEYBOX'
    brand_name = 'HEYBOX'
    brand_color = '#20242b'
    accent_segments = ((0, 240, '#f3c544'),)
    fallback_author = '小黑盒作者'

    def __init__(self, request, root):
        super().__init__(request, root)
        self.max_pages = min(4, max(1, int(request.get('maxPages', 4))))
        self.truncated = False
        self.slice_count = 0

    def heading(self):
        return '小黑盒 · 图文帖子'

    def picture(self, ref, indent=0, max_height=4400):
        path = self.local(ref)
        if path is None:
            self.paragraph('配图未能取得，请查看原帖。', size=24, color=shared.MUTED)
            return
        with Image.open(path) as source:
            width, height = shared.display_size(source)
            if width * height > Image.MAX_IMAGE_PIXELS:
                raise ValueError('HEYBOX_IMAGE_LIMIT')
            if height * (976 - indent * 2) / width <= max_height:
                return super().picture(ref, indent, max_height)
            picture = ImageOps.exif_transpose(source)
            slice_height = max(1, int(max_height * picture.width / (976 - indent * 2)))
            for y in range(0, picture.height, slice_height):
                name = f'render-slice-{self.slice_count}.png'
                self.slice_count += 1
                with picture.crop((0, y, picture.width, min(y + slice_height, picture.height))) as piece:
                    piece.save(self.root / name)
                key = f'render-slice-{self.slice_count}'
                self.paths[key] = str(self.root / name)
                super().picture({'assetKey': key}, indent, max_height)

    def pages(self):
        pages = [[]]
        used = 0
        for item in self.items:
            if used + item['height'] > 4800 and pages[-1]:
                if len(pages) == self.max_pages:
                    self.truncated = True
                    break
                pages.append([])
                used = 0
            pages[-1].append(item)
            used += item['height']
        if self.truncated:
            first = len(self.items)
            self.paragraph(f'帖子超过 {self.max_pages} 页展示上限，剩余内容请查看原帖。', size=24, color=shared.MUTED)
            notice = self.items[first:]
            while pages[-1] and sum(item['height'] for item in pages[-1] + notice) > 4800:
                pages[-1].pop()
            pages[-1].extend(notice)
        return pages

    def plan(self):
        c = self.content
        self.paragraph(c['title'], size=43)
        count = sum(block['type'] == 'image' for block in c.get('blocks', []))
        if count:
            self.paragraph(f'{count} 张配图', size=24, color=shared.MUTED)
        for block in c.get('blocks', []):
            if block['type'] == 'paragraph':
                self.paragraph(block['text'], size=30)
            elif block['type'] == 'image':
                self.picture(block['image'])
        if c.get('retrieval', {}).get('status') == 'partial':
            self.paragraph('部分内容或配图未能取得，完整内容以原帖为准。', size=24, color=shared.MUTED)
        return self.pages()


def main():
    os.umask(0o077)
    if sys.argv[1] == 'inspect':
        with Image.open(sys.argv[2]) as image:
            if image.format not in ('JPEG', 'PNG', 'GIF', 'WEBP'):
                raise ValueError('HEYBOX_IMAGE_FORMAT')
            width, height = shared.display_size(image)
            if width < 1 or height < 1 or width * height > int(sys.argv[3]):
                raise ValueError('HEYBOX_IMAGE_LIMIT')
        with Image.open(sys.argv[2]) as image:
            image.verify()
        print(json.dumps({'width': width, 'height': height}))
        return
    if sys.argv[1] != 'render':
        raise ValueError('HEYBOX_RENDER_INVALID')
    path = Path(sys.argv[2]).resolve()
    if path.stat().st_size > 1024 * 1024:
        raise ValueError('HEYBOX_RENDER_LIMIT')
    renderer = Renderer(json.loads(path.read_text()), path.parent)
    files = renderer.render()
    print(json.dumps({'files': files, 'truncated': renderer.truncated}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
