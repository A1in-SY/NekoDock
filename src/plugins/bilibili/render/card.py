"""Render bounded Bilibili presentation cards from validated local assets."""
import sys
from email.utils import parsedate_to_datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'plugin-system' / 'render'))
import nekodock_cards as shared
from nekodock_cards import BLUE, INK, MUTED, PINK, TZ, clusters, display_size, emoji_picture, font, label, stamp


class Renderer(shared.Renderer):
    error_prefix = 'BILIBILI'
    brand_name = 'BILIBILI'
    brand_color = PINK
    fallback_author = '哔哩哔哩'

    def heading(self):
        return '视频分享' if self.content['type'] == 'video' else '直播分享' if self.content['type'] == 'live' else '动态分享'

    def author_subtitle(self):
        return ('直播间 ' + self.content['live']['roomId']) if self.content['type'] == 'live' else stamp(self.content.get('publishedAt'))

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
        if c['type'] == 'video':
            self.video_document()
        elif c['type'] == 'live':
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
            self.paragraph('部分资料或图片未能取得，以原视频为准。' if c['type'] == 'video' else '部分资料或图片未能取得，以下内容以原分享为准。', size=23, color=MUTED)
        return self.pages()


def main():
    shared.run_cli(Renderer, 'BILIBILI')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
