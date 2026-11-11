"""Render a single Douyin video card from validated local assets."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'plugin-system' / 'render'))
import nekodock_cards as shared


class Renderer(shared.Renderer):
    error_prefix = 'DOUYIN'
    brand_name = '抖音'
    brand_color = '#292b35'
    brand_size = 29
    brand_top = 37
    heading_x = 135
    accent_segments = ((930, 1004, '#25d4df'), (1005, 1079, '#fe2c55'))
    fallback_author = '抖音'
    author_emoji = True

    def __init__(self, request, root):
        super().__init__(request, root)
        self.max_pages = 1

    def plan(self):
        if self.content.get('type') != 'video' or self.content.get('platform') != 'douyin':
            raise ValueError('DOUYIN_RENDER_INVALID')
        self.video_document(caption_only=True, cover_max_height=880)
        if self.content.get('retrieval', {}).get('status') == 'partial':
            self.paragraph('部分资料或图片未能取得，以原视频为准。', size=23, color=shared.MUTED)
        return self.pages()


def main():
    shared.run_cli(Renderer, 'DOUYIN')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
