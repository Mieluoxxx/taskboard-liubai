#!/usr/bin/env python3
"""重新生成 public/fonts/maple-mono-cn 下的子集字体与两个 CSS。

为什么需要它：Maple Mono NF CN 完整包是 156 MB / 16 个字重，
直接放仓库既超限又拖慢首屏。这里按“用途”切成四片并用 unicode-range 让浏览器按需取用。

用法（只在需要升级字体版本或调整分片时执行）：
    python3 -m venv .venv && ./.venv/bin/pip install fonttools brotli
    # 下载 https://github.com/subframe7536/maple-font/releases 的 MapleMono-NF-CN.zip
    # 与 SUBTLEX-CH 字频表（见下 SUBTLEX），放到 /tmp/maple 后：
    ./.venv/bin/python scripts/build-fonts.py

依赖的外部数据：
  - MapleMono-NF-CN-{Regular,SemiBold}.ttf  （SIL OFL 1.1）
  - SUBTLEX-CH-CHR 字频表（用于把常用汉字排在前面）
"""
from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options
import pathlib, shutil, subprocess, sys

SRC_DIR = pathlib.Path('/tmp/maple')
ROOT = pathlib.Path(__file__).resolve().parent.parent
VER = 'v7.9'
OUT = ROOT / 'public/fonts/maple-mono-cn' / VER
WEIGHTS = {'400': 'MapleMono-NF-CN-Regular.ttf', '600': 'MapleMono-NF-CN-SemiBold.ttf'}

if not (SRC_DIR / 'SUBTLEX-CH-CHR_converted_to_unicode.txt').exists():
    sys.exit('缺少字频表 /tmp/maple/SUBTLEX-CH-CHR_converted_to_unicode.txt')

freq = []
for line in (SRC_DIR / 'SUBTLEX-CH-CHR_converted_to_unicode.txt').read_text(encoding='utf-8').splitlines():
    parts = line.split('\t')
    if len(parts) >= 2 and len(parts[0]) == 1:
        try:
            int(parts[1])
        except ValueError:
            continue
        freq.append(ord(parts[0]))

cmap = TTFont(SRC_DIR / WEIGHTS['400'], lazy=True).getBestCmap()
is_pua = lambda c: 0xE000 <= c <= 0xF900

# 界面自身用到的字符，必须永远留在 core 里（否则界面文字会闪回系统字体）
ui_cps = set()
for path in list((ROOT / 'src').glob('*.ts')) + list((ROOT / 'src').glob('*.tsx')) + [ROOT / 'index.html']:
    for ch in path.read_text(encoding='utf-8'):
        if ord(ch) > 0x3400 and not is_pua(ord(ch)):
            ui_cps.add(ord(ch))

core = {c for c in cmap if c < 0x3400 and not is_pua(c)} | {c for c in ui_cps if c in cmap}
nerd = {c for c in cmap if is_pua(c)}
common = {c for c in freq[:3000] if c in cmap} - core - nerd
tail = set(cmap) - core - nerd - common
TIERS = {'core': core, 'common': common, 'tail': tail, 'nerd': nerd}
print({k: len(v) for k, v in TIERS.items()})

def ranges(cps):
    out, start, prev = [], None, None
    for c in sorted(cps):
        if start is None:
            start = prev = c
            continue
        if c == prev + 1:
            prev = c
            continue
        out.append((start, prev))
        start = prev = c
    if start is not None:
        out.append((start, prev))
    return out

def css_range(cps):
    toks = [f'U+{a:X}' if a == b else f'U+{a:X}-{b:X}' for a, b in ranges(cps)]
    lines, cur = [], ''
    for t in toks:
        if len(cur) + len(t) + 1 > 108:
            lines.append(cur)
            cur = ''
        cur += (',' if cur else '') + t
    if cur:
        lines.append(cur)
    return ',\n    '.join(lines)

OUT.mkdir(parents=True, exist_ok=True)
for weight, ttf in WEIGHTS.items():
    for tier, cps in TIERS.items():
        font = TTFont(SRC_DIR / ttf)
        options = Options()
        options.layout_features = ['*']
        options.name_IDs = ['*']
        options.notdef_outline = True
        options.drop_tables = []
        subsetter = Subsetter(options=options)
        subsetter.populate(unicodes=sorted(cps))
        subsetter.subset(font)
        font.flavor = 'woff2'
        target = OUT / f'{tier}-{weight}.woff2'
        font.save(target)
        print(f'  {target.name:18s} {target.stat().st_size / 1048576:.2f} MB')

def face(tier, weight):
    return f"""@font-face {{
  font-family: 'Maple Mono CN';
  font-style: normal;
  font-weight: {weight};
  font-display: swap;
  src: url('/fonts/maple-mono-cn/{VER}/{tier}-{weight}.woff2') format('woff2');
  unicode-range: {css_range(TIERS[tier])};
}}
"""

(ROOT / 'src/fonts.css').write_text(
    '/* 由 scripts/build-fonts.py 生成，请勿手改。Maple Mono NF CN（SIL OFL 1.1）。\n'
    ' * 关键字体：拉丁/数字/标点 + 界面中文（core），两个字重约 0.5 MB，由 index.html 预加载。\n'
    ' * 其余分片见 public/fonts/maple-mono-cn/fonts-lazy.css，异步加载不阻塞首屏。\n */\n'
    + face('core', '400') + '\n' + face('core', '600'),
    encoding='utf-8',
)
lazy = ('/* 由 scripts/build-fonts.py 生成，请勿手改。按需加载，不用到的分片不会下载。\n'
        ' * common 字频前 3000 中文 / tail 生僻字兜底 / nerd Nerd Font 图标（U+E000-F8FF）\n */\n'
        + '\n'.join(face(t, w) for w in WEIGHTS for t in ('common', 'tail', 'nerd')))
(ROOT / 'public/fonts/maple-mono-cn/fonts-lazy.css').write_text(lazy, encoding='utf-8')
shutil.copy(SRC_DIR / 'LICENSE.txt', ROOT / 'public/fonts/LICENSE-maple-mono.txt')
print('已更新 src/fonts.css、fonts-lazy.css 与许可文件')
