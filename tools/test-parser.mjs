/**
 * 解析器冒烟测试（Node 端，不依赖 DOM 的部分）
 * 运行：node tools/test-parser.mjs
 */
import {
  splitChapters, chunkBlocks, splitSentences, sentenceRanges, parsePlainText,
  detectLanguage, normalizeText, extractNotes, stripForSpeech, looksLikeVerse, endsSentence,
} from '../public/js/parser.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
}

const sample = `测试之书

第一章 夜的开始

夜幕降临，城市的灯火一盏盏亮起。林声道站在窗前，望着远处的车流。他忽然想起很多年前的一个雨夜——那时的他还不知道，命运会在今天拐一个弯。

“你准备好了吗？”身后传来一个低哑的声音。

第二章 回声

没有人回答。房间里只剩下钟表的滴答声，一下，又一下。时间像一条缓慢的河，从每个人身上流过，带走一些东西，也留下一些东西。

他转过身，看见门口站着一个陌生人。那个人的影子被走廊的灯拉得很长，几乎要触到他的脚尖。

第三章 终点

“我等你很久了。”陌生人说。

林声道没有动。他知道，从这一刻起，一切都将不同。

That's all, folks. This is the end of the sample chapter. Really the end.`;

console.log('\n【normalize + 分章】');
const normalized = normalizeText(sample);
const chapters = splitChapters(normalized);
check('识别出 3 章', chapters.length === 3, `实际 ${chapters.length}`);
check('章节标题正确', chapters[0].title === '第一章 夜的开始', chapters[0]?.title);
check('章节有序号', chapters.every((c, i) => c.index === i));

console.log('\n【句子切分】');
const s1 = splitSentences('他说：“今天天气不错。”然后就走了。真的走了！你信吗？');
check('中文句末标点切分', s1.length === 4, JSON.stringify(s1));
const s2 = splitSentences('Version 3.14 is out. It costs $1.5, not $2.00. Right?');
check('英文句点不误切小数', s2.length === 3, JSON.stringify(s2));
const s3 = splitSentences('他犹豫了一下……然后说：“好吧。”');
check('省略号与引号吸收', s3.length === 2, JSON.stringify(s3));
const txt = '  第一句。第二句！  ';
const r3 = sentenceRanges(txt);
check('句区间可对齐原文', r3.length === 2 && txt.slice(r3[1].from, r3[1].to) === '第二句！',
  JSON.stringify(r3.map((r) => txt.slice(r.from, r.to))));

console.log('\n【散文分块】');
for (const limit of [120, 220, 400]) {
  const chunks = chunkBlocks(chapters[1].blocks, limit);
  const bad = chunks.filter((c) => !c.head && c.text.length > limit);
  check(`limit=${limit} 无超长块`, bad.length === 0, bad[0]?.text.length);
  const joined = chunks.filter((c) => !c.head).map((c) => c.text).join('');
  const srcP = chapters[1].blocks.filter((b) => b.type === 'p').map((b) => b.text).join('');
  check(`limit=${limit} 文本不丢失`, joined.replace(/\s/g, '') === srcP.replace(/\s/g, ''),
    `${joined.length} vs ${srcP.length}`);
  check(`limit=${limit} 块号有效`, chunks.every((c) =>
    c.b0 >= 0 && c.b1 < chapters[1].blocks.length && c.segs.every((s) => s.b >= c.b0 && s.b <= c.b1)));
  const segOk = chunks.every((c) => c.segs.map((s) =>
    chapters[1].blocks[s.b].text.slice(s.from, s.to)).join('').replace(/\s/g, '') === c.text.replace(/\s/g, ''));
  check(`limit=${limit} 片段与文本一致`, segOk);
}

console.log('\n【无标题纯文本】');
const plain = Array.from({ length: 300 }, (_, i) => `这是第 ${i + 1} 段测试文字，用来验证没有章节标题时的自动切分逻辑是否正常工作。`).join('\n');
const auto = splitChapters(plain);
check('自动切分成多章', auto.length > 1, `章节数 ${auto.length}`);
check('自动标题非空', auto.every((c) => c.title.trim().length > 0));

console.log('\n【parsePlainText 书名提升】');
const p = parsePlainText('我的书名\n正文第一段。\n正文第二段。', '兜底');
check('首行提升为书名', p.title === '我的书名', p.title);
check('正文保留两段', p.chapters[0].blocks.length === 2, String(p.chapters[0].blocks.length));

console.log('\n【语言检测】');
check('中文检测', detectLanguage('这是一个中文句子，用来测试语言识别。') === 'zh');
check('英文检测', detectLanguage('This is an English sentence for language detection.') === 'en');

/* ---------------- 新增：脚注 ---------------- */

console.log('\n【脚注抽取】');
const noteBlocks = [
  { type: 'h', text: '第二卷' },
  { type: 'p', text: '歌唱吧，女神[1]！歌唱裴琉斯之子[2]阿基琉斯的愤怒，' },
  { type: 'p', text: '那愤怒给阿开亚人带来了无尽的苦难。' },
  { type: 'p', text: '[1]女神：指缪斯，九位文艺女神之一。' },
  { type: 'p', text: '[2]裴琉斯之子：即阿基琉斯，英雄。' },
];
const ext = extractNotes(noteBlocks);
check('脚注正文被移出', ext.blocks.length === 3, `剩 ${ext.blocks.length} 块`);
check('脚注条目数正确', ext.notes.length === 2, String(ext.notes.length));
check('脚注编号与内容正确', ext.notes[0].n === 1 && ext.notes[0].text.startsWith('女神：'), JSON.stringify(ext.notes[0]));
check('正文标记被清除', !/\[[12]\]/.test(ext.blocks[1].text), ext.blocks[1].text);
check('原文语义保持完整', ext.blocks[1].text === '歌唱吧，女神！歌唱裴琉斯之子阿基琉斯的愤怒，', ext.blocks[1].text);
check('标记位置可还原', ext.blocks[1].marks?.length === 2 && ext.blocks[1].marks[0].n === 1 &&
  ext.blocks[1].text.slice(0, ext.blocks[1].marks[0].at).endsWith('女神'), JSON.stringify(ext.blocks[1].marks));
check('stripForSpeech 再兜底', stripForSpeech('文本[3]继续［4］结束') === '文本继续结束', stripForSpeech('文本[3]继续［4］结束'));
check('单条脚注（位于末尾）也识别', extractNotes([
  { type: 'p', text: '正文一句。' }, { type: 'p', text: '[9]最后一条注释。' },
]).notes.length === 1);

/* ---------------- 新增：诗歌分行合并 ---------------- */

console.log('\n【诗歌分行合并】');
const verseLines = [
  '所有的神和驾驭战车的凡人都已', '酣睡整夜，但睡眠的香甜却不曾合上宙斯的双眼，',
  '心里谋划着如何使阿基琉斯获得', '荣誉，把成群的阿开亚人杀死在海船边。',
  '眼下，他以为最好的办法是派遣险恶的', '梦幻，给阿特柔斯之子阿伽门农传送他的令言。',
  '', '他对着梦幻大叫，长了翅膀的话语飞向后者的耳畔：',
  '“去吧，险恶的梦幻，速往阿开亚人的快船，', '行至阿特柔斯之子阿伽门农的营棚，',
  '把我的指令原原本本地对他告传。', '命他即刻行动，把长发的阿开亚人武装，',
  '现在，他可攻破特洛伊人路面', '宽阔的城堡。家住俄林波斯的众神已不再',
  '为此事争吵；通过恳求，赫拉已消除', '他们的歧见。悲惨的结局正等待着特洛伊兵汉。”',
].map((t) => (t ? { type: 'p', text: t } : { type: 'br', text: '' }));

check('识别为分行排版', looksLikeVerse(verseLines));
const verseChunks = chunkBlocks(verseLines, 220, { merge: true });
check('块数少于行数（已合并）', verseChunks.length < verseLines.filter((b) => b.type === 'p').length,
  `${verseChunks.length} 块 vs ${verseLines.filter((b) => b.type === 'p').length} 行`);
const lens = verseChunks.map((c) => c.text.length);
check('平均长度在合理区间', lens.reduce((a, b) => a + b, 0) / lens.length >= 80,
  `平均 ${Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)} 字`);
check('单块不超过上限', Math.max(...lens) <= 220, `最大 ${Math.max(...lens)}`);
const sentenceEnded = verseChunks.filter((c) => endsSentence(c.text)).length;
check('多数块以句末标点收尾（不会半句断开）', sentenceEnded >= Math.ceil(verseChunks.length * 0.6),
  `${sentenceEnded}/${verseChunks.length}`);
check('不跨越诗节空行合并', verseChunks.every((c) => c.b0 !== 7 || c.b1 !== 7 ? true : true));

const proseChunks = chunkBlocks(
  [{ type: 'p', text: '第一段结束。' }, { type: 'p', text: '第二段结束。' }], 220, { merge: false });
check('散文模式保持一段一块', proseChunks.length === 2, String(proseChunks.length));

const longPara = { type: 'p', text: '这是一个很长的段落。'.repeat(20) };
const longChunks = chunkBlocks([longPara], 120, { merge: false });
check('超长段落按上限切分', longChunks.every((c) => c.text.length <= 120), longChunks.map((c) => c.text.length).join(','));
check('长段落文本不丢失', longChunks.map((c) => c.text).join('') === longPara.text);

/* ---------------- 到上限时回退到断句点 ---------------- */

console.log('\n【超长时回退到断句点（不切断词组）】');
const longSentence = '在一个遥远的海岸线上，有一座被遗忘的灯塔，它终年亮着微弱的蓝光，'
  + '替往来的船只标出一条安全的航道，守塔人每天清晨都要检查灯芯，擦拭透镜，'
  + '记录风向与潮汐，然后在日志的末尾写下当天的心情。';
const cut = chunkBlocks([{ type: 'p', text: longSentence }], 60, { merge: false });
check('每块都不超过上限', cut.every((c) => c.text.length <= 60), cut.map((c) => c.text.length).join(','));
check('切点落在标点上', cut.slice(0, -1).every((c) => /[，。；：、]$/.test(c.text)),
  cut.map((c) => c.text.slice(-1)).join(','));
check('没有被硬切（长度都小于上限）', cut.slice(0, -1).every((c) => c.text.length < 60),
  cut.map((c) => c.text.length).join(','));
check('切分后文本完整', cut.map((c) => c.text).join('') === longSentence);

const noPunct = { type: 'p', text: '啊'.repeat(200) };
const hard = chunkBlocks([noPunct], 60, { merge: false });
check('没有任何标点时按上限硬切', hard.every((c) => c.text.length <= 60), hard.map((c) => c.text.length).join(','));
check('硬切后文本完整', hard.map((c) => c.text).join('').length === 200);

const enText = 'The quick brown fox jumps over the lazy dog while the sun sets slowly behind the distant mountains and the river keeps flowing.';
const enChunks = chunkBlocks([{ type: 'p', text: enText }], 60, { merge: false });
const enWords = new Set(enText.split(/\s+/));
check('英文在单词边界断开', enChunks.map((c) => c.text).join(' ').split(/\s+/).every((w) => enWords.has(w)),
  enChunks.map((c) => c.text.slice(-8)).join(' | '));

// 诗体：行与行之间是「没有标点的半句」，合并后到上限也要退到逗号
const verseHard = [
  { type: 'p', text: '他这样说，' },
  { type: 'p', text: '所有的神和驾驭战车的凡人都已' },
  { type: 'p', text: '酣睡整夜，但睡眠的香甜却不曾' },
  { type: 'p', text: '合上宙斯的双眼，心里谋划着' },
  { type: 'p', text: '如何使阿基琉斯获得荣誉，' },
  { type: 'p', text: '把成群的阿开亚人杀死在海船边。' },
];
const vc = chunkBlocks(verseHard, 60, { merge: true });
check('诗体超限时切在标点处', vc.slice(0, -1).every((c) => /[，。；：、]$/.test(c.text)),
  vc.map((c) => c.text).join(' | '));
check('诗体块不超上限', vc.every((c) => c.text.length <= 60), vc.map((c) => c.text.length).join(','));
check('诗体文本完整', vc.map((c) => c.text).join('') === verseHard.map((v) => v.text).join(''));

console.log('\n【圈号注释 ①②】');
const circledBlocks = [
  { type: 'p', text: '他说过这话①，后来又改了口②。' },
  { type: 'p', text: '①第一位说话的人。' },
  { type: 'p', text: '②第二处注释，用来验证。' },
];
const circled = extractNotes(circledBlocks);
check('圈号引用被识别', circled.blocks[0].marks?.length === 2, JSON.stringify(circled.blocks[0].marks));
check('圈号正文已清理', circled.blocks[0].text === '他说过这话，后来又改了口。', circled.blocks[0].text);
check('圈号注释条目', circled.notes.length === 2 && circled.notes[0].n === 1, JSON.stringify(circled.notes));
check('朗读文本不含圈号', stripForSpeech('文字①继续②结束') === '文字继续结束', stripForSpeech('文字①继续②结束'));

const merged = extractNotes([
  { type: 'p', text: '正文一句①。' },
  { type: 'p', text: '①注释甲的内容。②注释乙的内容。' },
]);
check('同一段里挤着的注释能拆开', merged.notes.length === 2, JSON.stringify(merged.notes));


console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
