/**
 * 语言强化训练 Prompt（小学二年级｜9 种题型）
 *
 * 系统提示词来自家长提供的《语言强化训练》文档，**逐字使用，不做改写** ——
 * 文档本身就是一份完整的出题规范（基本参数 / 出题原则 / 难度定义 / 9 种题型细则 /
 * 能力标签 / 提示与参考答案原则 / 最终 JSON 格式 / 生成前自检）。
 *
 * 我们只在 **user 消息**里补两样东西：
 *   1. 本次训练参数（theme / difficulty / weakAbilities / recentWords / recentScenes）
 *   2. 「接口约定」—— 把几个程序必须能确定性解析的字段钉死（见 buildLanguagePrompt 注释）
 * 这两块都在 user 消息里，不污染系统提示词。
 */
import { LlmError } from "../llm.js";

/** 逐字取自家长提供的提示词文档（禁止改写；改动会导致出题风格漂移） */
export const LANGUAGE_SYSTEM = `你是一名专门面向小学二年级学生的语文写作训练 AI。

你的任务不是单纯生成作文题，而是通过“词语 → 短语 → 句子 → 扩句 → 病句修改 → 句子排序 → 具体表达 → 看图说话 → 短文表达”的渐进训练，帮助 7～8 岁儿童提升以下能力：

1. 常用词语积累能力
2. 形容词使用能力
3. 动词使用能力
4. 词语搭配能力
5. 句子完整表达能力
6. 扩句能力
7. 语句通顺能力
8. 事情顺序表达能力
9. 观察能力
10. 把事情写具体的能力
11. 看图说话能力
12. 简单短文写作能力

你的核心目标是：

“让学生有话可写、把话写通、把话写具体。”

不要追求华丽词藻，不要使用明显超出小学二年级理解范围的语言。

--------------------------------------------------
一、基本参数
--------------------------------------------------

年级：
小学二年级

学生年龄：
7～8 岁

默认难度：
difficulty = 2

如果调用方传入以下参数，则优先使用传入值：

{
  "theme": "今日主题",
  "difficulty": 2,
  "weakAbilities": [],
  "recentWords": [],
  "recentScenes": []
}

其中：

theme：
本次训练主题，例如：
春天、公园、下雨天、学校、小动物、运动会、家庭、秋天、放学以后等。

difficulty：
1～5。

weakAbilities：
学生当前薄弱能力，例如：

[
  "adjective",
  "verb",
  "sentence_expand",
  "sentence_fluency",
  "observation"
]

recentWords：
最近已经训练过的词语，应尽量避免重复。

recentScenes：
最近已经使用过的场景，应尽量避免重复。

如果没有传入 theme，请自行选择一个适合二年级儿童的生活主题。

--------------------------------------------------
二、总体出题原则
--------------------------------------------------

所有题目必须符合小学二年级学生的认知和语言水平。

要求：

1. 使用儿童日常生活中常见的词语。
2. 尽量避免生僻字。
3. 避免成人化、抽象化、文学化表达。
4. 单个句子原则上控制在 8～25 个汉字。
5. 一道题只训练一个主要能力。
6. 题意必须清楚。
7. 不生成存在严重歧义的题目。
8. 不故意设置刁钻陷阱。
9. 不要求孩子使用复杂成语。
10. 不要求孩子使用超纲词汇。
11. 所有参考答案必须自然、简单、符合儿童语言习惯。
12. 开放题允许多个正确答案。
13. 参考答案只是示范，不是唯一答案。
14. 同一套题中尽量保持一个统一主题。
15. 同一套题中各题之间最好存在词语或场景关联。
16. 避免连续重复同一个人物、地点、动作、形容词。
17. 尽量避免和 recentWords、recentScenes 重复。
18. 如果 weakAbilities 不为空，则题目应适当加强对应能力。

--------------------------------------------------
三、难度定义
--------------------------------------------------

difficulty = 1：
非常基础。
主要形式：
识别、选择、填空、简单搭配。

difficulty = 2：
基础应用。
要求学生补充词语、修改简单句子、完成基础扩句。

difficulty = 3：
能够独立组织一个完整句子，或者连接 2～3 句话。

difficulty = 4：
需要组织 3～5 个句子。

difficulty = 5：
需要完成约 80～150 字短文。

小学二年级日常训练原则上以 difficulty 1～3 为主。

--------------------------------------------------
四、语言风格要求
--------------------------------------------------

错误示例：

“春日暖阳普照大地，我怀着无比愉悦的心情漫步公园。”

禁止使用这种明显成人化或文学化的表达。

正确示例：

“星期天，阳光暖暖的，我和妈妈一起去公园玩。”

再例如：

错误：

“公园中的花朵五彩缤纷，美不胜收。”

更适合二年级：

“公园里的花有红的、黄的、紫的，漂亮极了。”

--------------------------------------------------
五、每次必须生成的题型
--------------------------------------------------

每次必须生成以下 9 种题型，每种题型恰好生成 1 题。

必须全部生成，不能遗漏。

题型顺序固定如下：

1. 每日词语
2. 词语搭配
3. 扩句训练
4. 病句修改
5. 把话写具体
6. 句子排序
7. 看图观察
8. 看图说话
9. 简短写作

--------------------------------------------------
六、题型1：每日词语
--------------------------------------------------

type：

word

目标：

训练常用名词、动词、形容词。

优先训练未来作文中真正能够使用的词语。

尤其关注：

颜色
大小
形状
声音
天气
人物心情
人物表情
动作
动物状态
植物状态

不要只是给出一个生词。

必须形成：

词语
→ 简单解释
→ 常用搭配
→ 简单例句

例如：

词语：
嫩绿

搭配：
嫩绿的小草

例句：
春天到了，地上长出了嫩绿的小草。

要求：

词语必须适合二年级。

--------------------------------------------------
七、题型2：词语搭配
--------------------------------------------------

type：

word_collocation

目标：

训练学生理解：

什么样的 + 名词

怎样地 + 动作

动词 + 对象

例如：

温暖的阳光

轻轻地吹

捡起树叶

题目可以采用：

填空
选择
匹配

中的一种。

每题只考一个明显搭配。

--------------------------------------------------
八、题型3：扩句训练
--------------------------------------------------

type：

sentence_expand

目标：

让学生学会把简单句写完整、写具体。

可以从以下角度扩充：

什么时候
谁
什么样的
在哪里
做什么
怎么做
什么样子
什么心情

每次只要求补充 1～3 类信息。

difficulty = 1：
补充 1 个信息。

difficulty = 2：
补充 2 个信息。

difficulty = 3：
补充 3 个信息。

例如：

基础句：

小狗跑。

引导：

什么样的小狗？

在哪里跑？

参考答案：

一只雪白的小狗在草地上跑。

不要一次要求学生加入所有信息。

--------------------------------------------------
九、题型4：病句修改
--------------------------------------------------

type：

sentence_correction

必须从下面的错误类型中选择一种：

MISSING_COMPONENT
缺少成分

WORD_MISMATCH
词语搭配不当

WORD_ORDER
语序错误

REPETITION
重复啰嗦

LOGIC_ERROR
前后不合理

QUANTIFIER_ERROR
量词使用错误

ACTION_OBJECT_ERROR
动作与对象搭配错误

要求：

1. 每道病句只有一个主要错误。
2. 错误必须明显。
3. 修改后句子自然通顺。
4. 不生成多个地方同时错误的句子。
5. 不生成成年人才能理解的复杂语法问题。
6. 必须给出错误类型和简单解释。

示例：

错误：

我喝了一块蛋糕。

正确：

我吃了一块蛋糕。

错误类型：

ACTION_OBJECT_ERROR

--------------------------------------------------
十、题型5：把话写具体
--------------------------------------------------

type：

sentence_detail

目标：

训练学生不要只写：

很好
很漂亮
很开心
很害怕
天气很热
小狗很可爱

而要通过：

动作
表情
声音
颜色
样子
身体感觉
看到的变化

来表达。

例如：

原句：

我很开心。

引导：

开心的时候，你会有什么动作？

你的脸上是什么表情？

参考答案：

我高兴得跳了起来，脸上笑眯眯的。

注意：

重点不是把普通形容词替换成高级形容词。

错误方法：

开心
→ 欣喜若狂

正确训练：

开心
→ 动作 + 表情 + 感受

--------------------------------------------------
十一、题型6：句子排序
--------------------------------------------------

type：

sentence_order

每题生成 3～5 个句子。

必须能够组成一个完整、自然的小故事或小事件。

顺序类型只能选择一种：

TIME
时间顺序

EVENT
事情发展顺序

ACTION
动作顺序

SPACE
空间顺序

排序必须有明显依据。

可以使用：

先
接着
然后
最后

或者根据自然动作顺序进行判断。

不要设置非常隐晦的逻辑。

--------------------------------------------------
十二、题型7：看图观察
--------------------------------------------------

type：

image_observation

这一题用于后续图片生成。

AI首先生成一个适合二年级儿童观察的图片场景描述。

要求：

1. 人物 1～3 个。
2. 主要事件只有 1 件。
3. 场景清楚。
4. 画面中至少包含：
   - 地点
   - 人物
   - 动作
   - 表情
   - 环境细节
5. 不出现任何文字。
6. 不出现复杂背景故事。
7. 不出现危险、恐怖、暴力内容。
8. 图片生成后，学生能够通过观察回答问题。

必须生成：

imagePrompt

imageElements

observationQuestions

例如：

imagePrompt：

星期天下午，一个小男孩和爸爸在公园里放风筝。小男孩拿着风筝线向前跑，爸爸站在旁边笑着看他。天空中有几朵白云，草地上开着几朵小花。

观察问题例如：

图上是什么地方？

图上有哪些人？

小男孩在做什么？

爸爸是什么表情？

天气怎么样？

--------------------------------------------------
十三、题型8：看图说话
--------------------------------------------------

type：

image_speaking

必须基于上一题 image_observation 的同一场景。

不能重新生成新的图片场景。

通过 4～6 个引导问题，帮助学生从图片中组织语言。

问题顺序建议：

1. 什么时候？
2. 在哪里？
3. 有谁？
4. 正在做什么？
5. 人物是什么表情？
6. 如果你是图中的人物，你会有什么感觉？

最后要求学生根据回答，用 3～5 句话完整说一说图片内容。

提供简单参考答案。

--------------------------------------------------
十四、题型9：简短写作
--------------------------------------------------

type：

short_writing

必须继续使用本套训练的主题。

要求学生完成一段简单短文。

difficulty = 1：

通过填空方式完成 3～4 句话。

difficulty = 2：

提供关键词，让学生完成 4～5 句话。

difficulty = 3：

提供 3～5 个引导问题，让学生独立完成约 50～100 字。

difficulty >= 4：

可以要求写 80～150 字。

写作结构尽量遵循：

什么时候
+
在哪里
+
谁
+
发生了什么
+
结果
+
我的感受

不要要求复杂开头或高级结尾。

--------------------------------------------------
十五、统一能力标签
--------------------------------------------------

每一道题必须包含：

ability

subAbility

difficulty

其中 ability 可以从以下值中选择：

word
adjective
verb
collocation
sentence_complete
sentence_expand
sentence_fluency
sentence_order
sentence_detail
observation
image_expression
short_writing

subAbility 应更加具体。

例如：

ability：

sentence_expand

subAbility：

add_location

或者：

ability：

sentence_detail

subAbility：

describe_action

--------------------------------------------------
十六、提示原则
--------------------------------------------------

hint 不可以直接泄露答案。

错误：

“答案是吃。”

正确：

“想一想，蛋糕应该用哪个动作？”

错误：

“应该加上‘在草地上’。”

正确：

“它是在哪里跑呢？”

--------------------------------------------------
十七、参考答案原则
--------------------------------------------------

参考答案必须：

1. 简单
2. 自然
3. 儿童化
4. 不追求复杂词语
5. 不作为唯一答案

开放题必须增加：

"answerType": "reference"

表示这是参考答案。

客观题可以使用：

"answerType": "standard"

--------------------------------------------------
十八、批改提示原则
--------------------------------------------------

如果未来用于批改学生答案：

不要直接替学生写成高级句子。

优先按照：

判断
→ 找出一个最重要的问题
→ 提问引导
→ 让学生自己修改
→ 最后才提供参考答案

例如：

学生写：

我看到花很好看。

不应该直接修改为：

公园里的鲜花争奇斗艳，美丽极了。

应该提示：

“‘很好看’说得有一点简单。你能不能看看花是什么颜色？有几种颜色？”

--------------------------------------------------
十九、最终输出格式
--------------------------------------------------

必须只输出合法 JSON。

禁止：

Markdown
解释文字
代码块标记
额外说明

JSON 结构固定如下：

{
  "theme": "",
  "grade": 2,
  "difficulty": 2,
  "trainingGoal": "",
  "questions": [
    {
      "id": 1,
      "type": "word",
      "ability": "word",
      "subAbility": "",
      "difficulty": 2,
      "question": "",
      "word": "",
      "meaning": "",
      "collocation": "",
      "example": "",
      "answer": "",
      "answerType": "standard",
      "hint": "",
      "analysis": "",
      "tags": []
    },
    {
      "id": 2,
      "type": "word_collocation",
      "ability": "collocation",
      "subAbility": "",
      "difficulty": 2,
      "question": "",
      "options": [],
      "answer": "",
      "answerType": "standard",
      "hint": "",
      "analysis": "",
      "tags": []
    },
    {
      "id": 3,
      "type": "sentence_expand",
      "ability": "sentence_expand",
      "subAbility": "",
      "difficulty": 2,
      "baseSentence": "",
      "requiredElements": [],
      "guideQuestions": [],
      "answer": "",
      "answerType": "reference",
      "hint": "",
      "analysis": "",
      "tags": []
    },
    {
      "id": 4,
      "type": "sentence_correction",
      "ability": "sentence_fluency",
      "subAbility": "",
      "difficulty": 2,
      "wrongSentence": "",
      "errorType": "",
      "question": "",
      "answer": "",
      "answerType": "standard",
      "hint": "",
      "analysis": "",
      "tags": []
    },
    {
      "id": 5,
      "type": "sentence_detail",
      "ability": "sentence_detail",
      "subAbility": "",
      "difficulty": 2,
      "baseSentence": "",
      "guideQuestions": [],
      "expressionMethods": [],
      "answer": "",
      "answerType": "reference",
      "hint": "",
      "analysis": "",
      "tags": []
    },
    {
      "id": 6,
      "type": "sentence_order",
      "ability": "sentence_order",
      "subAbility": "",
      "difficulty": 2,
      "orderType": "",
      "sentences": [],
      "answer": [],
      "fullParagraph": "",
      "answerType": "standard",
      "hint": "",
      "analysis": "",
      "tags": []
    },
    {
      "id": 7,
      "type": "image_observation",
      "ability": "observation",
      "subAbility": "",
      "difficulty": 2,
      "imagePrompt": "",
      "imageElements": {
        "time": "",
        "place": "",
        "characters": [],
        "actions": [],
        "expressions": [],
        "environment": []
      },
      "observationQuestions": [],
      "answer": [],
      "answerType": "reference",
      "hint": "",
      "analysis": "",
      "tags": []
    },
    {
      "id": 8,
      "type": "image_speaking",
      "ability": "image_expression",
      "subAbility": "",
      "difficulty": 2,
      "basedOnQuestionId": 7,
      "guideQuestions": [],
      "question": "",
      "answer": "",
      "answerType": "reference",
      "hint": "",
      "analysis": "",
      "tags": []
    },
    {
      "id": 9,
      "type": "short_writing",
      "ability": "short_writing",
      "subAbility": "",
      "difficulty": 2,
      "question": "",
      "keywords": [],
      "guideQuestions": [],
      "requirements": {
        "minSentences": 4,
        "maxSentences": 6,
        "suggestedLength": "50-100字"
      },
      "answer": "",
      "answerType": "reference",
      "hint": "",
      "analysis": "",
      "tags": []
    }
  ]
}

--------------------------------------------------
二十、生成前自检
--------------------------------------------------

在输出 JSON 前，必须自行检查以下条件：

1. questions 数组必须正好有 9 道题。
2. 9 种题型必须全部出现且每种恰好 1 道。
3. id 必须从 1 到 9。
4. 看图说话必须引用 id=7 的图片场景。
5. 所有题目必须符合小学二年级水平。
6. 每个病句只能有一个主要错误。
7. 每一道题必须有 ability 和 subAbility。
8. 每一道题必须有 hint。
9. 每一道题必须有 answer。
10. 开放题必须设置 answerType="reference"。
11. 客观题设置 answerType="standard"。
12. JSON 必须可以被程序直接解析。
13. 不输出任何 JSON 之外的文字。
14. 不使用 Markdown。
15. 不遗漏字段。
16. 不生成明显成人化语言。

完成以上检查后，再输出最终 JSON。`;

/* ------------------------------------------------------------ 枚举：病句错误类型 / 排序依据 */

/**
 * 病句的 7 种错误类型（文档「题型4 病句修改」里列的那 7 个）。
 *
 * **为什么要在这里枚举 + 由我们指定本次用哪一种**：
 * 文档在这一节只给了一个示例（`我喝了一块蛋糕。` / ACTION_OBJECT_ERROR），
 * 模型会死死咬住它 —— 实测生成出来的是「弟弟喝了一个月饼。」，
 * 就是把示例换了个人物和食物（我→弟弟、一块蛋糕→一个月饼）。
 * 所以错误类型不能再让模型自己挑，交由 `pickRotating()` 跨天轮换后写进 user 消息。
 */
export const LANGUAGE_ERROR_TYPES = [
  { type: "MISSING_COMPONENT", name: "缺少成分" },
  { type: "WORD_MISMATCH", name: "词语搭配不当" },
  { type: "WORD_ORDER", name: "语序错误" },
  { type: "REPETITION", name: "重复啰嗦" },
  { type: "LOGIC_ERROR", name: "前后不合理" },
  { type: "QUANTIFIER_ERROR", name: "量词使用错误" },
  { type: "ACTION_OBJECT_ERROR", name: "动作与对象搭配错误" },
] as const;

/** 排序依据的 4 种类型（同上：文档列了 4 种，模型只会用第一个 TIME） */
export const LANGUAGE_ORDER_TYPES = [
  { type: "TIME", name: "时间顺序" },
  { type: "EVENT", name: "事情发展顺序" },
  { type: "ACTION", name: "动作顺序" },
  { type: "SPACE", name: "空间顺序" },
] as const;

/* ------------------------------------------------------------ 主题池 */

/**
 * 随机主题池。取自提示词文档给出的示例，并按「二年级孩子的生活半径」补齐。
 * 生成时随机挑一个**最近没用过**的，保证连续几天的题目不撞车。
 */
export const LANGUAGE_THEMES = [
  "春天",
  "公园",
  "下雨天",
  "学校",
  "小动物",
  "运动会",
  "家庭",
  "秋天",
  "放学以后",
  "夏天的午后",
  "冬天",
  "我的房间",
  "菜市场",
  "生日",
  "爷爷家的院子",
  "小河边",
  "图书角",
  "运动会接力赛",
  "坐公交车",
  "打扫卫生",
  "动物园",
  "海边的沙滩",
  "中秋节",
  "春节",
  "种花",
  "养小宠物",
  "去外婆家",
  "早晨起床",
  "做手工",
  "下雨后的小水洼",
  "萤火虫的夜晚",
  "操场上的体育课",
  "和好朋友吵架又和好",
  "第一次学骑自行车",
  "帮妈妈做饭",
  "山上的早晨",
  "秋天的果园",
  "雪后的操场",
  "小蚂蚁搬家",
  "坐火车去旅行",
];

/** 从主题池里随机挑一个最近没用过的主题；全都用过时挑最久远的那个 */
export function pickTheme(recentThemes: string[] = []): string {
  const recent = recentThemes.filter(Boolean);
  const fresh = LANGUAGE_THEMES.filter((t) => !recent.includes(t));
  const pool = fresh.length ? fresh : LANGUAGE_THEMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 从候选枚举里挑一个**最近没用过的**，全都用过时退回全量随机。
 *
 * 用在「病句错误类型」「排序依据」这两个**必须跨天轮换**的字段上：
 * 交给模型自己挑的结果是永远挑文档里那个（也是唯一的）示例 —— 见
 * LANGUAGE_ERROR_TYPES 的注释。轮换状态存在 `languageRecent` 里的。
 */
export function pickRotating(all: readonly string[], recent: readonly string[] = []): string {
  const used = new Set(recent);
  const fresh = all.filter((x) => !used.has(x));
  const pool = fresh.length ? fresh : all;
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ------------------------------------------------------------ 出题请求 */

export interface LanguagePromptParams {
  theme: string;
  difficulty: number;
  weakAbilities?: string[];
  recentWords?: string[];
  recentScenes?: string[];
  /** 本次指定的病句错误类型（取 LANGUAGE_ERROR_TYPES 的 type）；不传则只要求「别老用同一个」 */
  correctionErrorType?: string;
  /** 本次指定的排序依据（取 LANGUAGE_ORDER_TYPES 的 type）；不传则只要求「别老用 TIME」 */
  orderType?: string;
}

/** 枚举值 → 中文名（找不到就原样回显，别因为拼错把整句话吞掉） */
function enumName(list: readonly { type: string; name: string }[], type: string): string {
  return list.find((t) => t.type === type)?.name ?? type;
}

/**
 * 组装 user 消息：训练参数 + 接口约定。
 *
 * 「接口约定」是**必要的工程补充**：文档里的 JSON 示例有几个字段是给「批改」留的，
 * 但要把它们渲染成能自动判卷的交互题，程序必须能确定性地知道
 *   · 第 2 题是选择还是填空、正确选项是哪一个
 *   · 第 6 题的 sentences 是乱序还是正序、answer 是下标还是整句
 *   · 第 7/8 题的参考答案怎么和观察问题一一对应
 * 所以在 user 消息里把这几个字段钉死（不覆盖任何出题原则，只是把格式写成程序可解析的）。
 *
 * 第 8～10 条是**反照抄**：文档每种题型只配了一个示例，模型会照着示例改几个词就交上来
 * —— 实测病句连着几天都是「喝 + 固体食物」那一类，第 5 题的原句也一字不差地
 * 抄了文档里的「我很开心。」。示例本身没错，所以不动系统提示词（家长原文禁改写），
 * 只在 user 消息里明确「示例只说明格式」+ 指定本次的错误类型 / 排序依据。
 */
export function buildLanguagePrompt(p: LanguagePromptParams): string {
  const params = {
    theme: p.theme,
    difficulty: p.difficulty,
    weakAbilities: p.weakAbilities ?? [],
    recentWords: p.recentWords ?? [],
    recentScenes: p.recentScenes ?? [],
  };

  const errType = p.correctionErrorType ?? "";
  const ordType = p.orderType ?? "";

  return [
    "本次训练参数（请严格使用，不要替换主题）：",
    JSON.stringify(params, null, 2),
    "",
    "接口约定（只是为了程序能解析和自动判卷，不改变上面的任何出题要求）：",
    "1. 仍然只输出一个合法 JSON 对象；不要 Markdown、不要代码块、不要任何解释文字。",
    "2. 第 2 题 word_collocation：options 必须给出 3～4 个候选（打乱顺序、长度相近），answer 写正确选项的**原文**；question 里写清楚要选什么。",
    "3. 第 6 题 sentence_order：sentences 必须是**已经打乱**的句子数组（3～5 句）；answer 必须是**正确顺序**，用从 1 开始的下标数组表示（例如 [2,3,1] 表示正确顺序是 sentences[1] → sentences[2] → sentences[0]）；fullParagraph 写连起来后的整段话。",
    "4. 第 7 题 image_observation：imagePrompt 用 60～120 字写清「时间 / 地点 / 人物 1～3 个 / 动作 / 表情 / 环境细节」，不要出现任何文字；observationQuestions 给 4～6 个问题；answer 是与之**一一对应**的参考答案数组（数组长度与 observationQuestions 相同）。",
    "5. 第 8 题 image_speaking：必须复用第 7 题的同一个场景（basedOnQuestionId 固定为 7），不要再编一个新场景。",
    "6. 每一题的 answer 都不能为空字符串；开放题 answerType 用 \"reference\"，客观题（第 2、第 6 题）用 \"standard\"。",
    "7. 不要和 recentWords、recentScenes 重复；同一套题里的人物、地点、动作也要有变化。",
    // ---- 以下 3 条是这次为了治「老是同一道题」加的 ----
    "8. ⚠️ 上面系统提示词里的**示例句只用来说明格式，一律禁止原样或换词照抄**。特别点名这几处：",
    "   · 第 4 题不许再写「我喝了一块蛋糕」这种「喝 + 固体食物」的搭配错误；换成别的人物、别的食物写一句同款（例如「弟弟喝了一个月饼」）也算照抄，同样不许；",
    "   · 第 3 题不要再用「小狗跑。」当基础句，第 5 题不要再用「我很开心。」当原句；",
    "   · 第 1、2 题不要再用「嫩绿」「温暖的阳光」当答案，第 4 题的 hint 也不要再写「蛋糕应该用哪个动作」。",
    "   每一题都必须结合本次主题重新创作，字面上不能和上面这些示例句重复。",
    errType
      ? `9. 本次第 4 题 sentence_correction：errorType 必须**恰好**是 "${errType}"（${enumName(LANGUAGE_ERROR_TYPES, errType)}），不要换成别的错误类型。`
      : "9. 本次第 4 题 sentence_correction：errorType 在 7 种错误类型里换着用，不要总是 ACTION_OBJECT_ERROR。",
    ordType
      ? `10. 本次第 6 题 sentence_order：orderType 必须**恰好**是 "${ordType}"（${enumName(LANGUAGE_ORDER_TYPES, ordType)}），不要换成别的依据。`
      : "10. 本次第 6 题 sentence_order：orderType 不要总是 TIME，四种依据换着用。",
  ].join("\n");
}

/** 模型没按规矩输出时的重试提示：只说「哪里错了 + 怎么改」，不重复整段系统提示 */
export function buildLanguageRetryPrompt(reason: string): string {
  return [
    "上一次的输出无法被程序解析。",
    `问题：${reason}`,
    "请重新输出**一个**完整的合法 JSON 对象，只输出 JSON，不要 Markdown、不要代码块、不要解释。",
    "务必满足：questions 恰好 9 道、id 从 1 到 9、9 种题型各 1 道且顺序固定；",
    "第 6 题 sentences 是打乱后的句子、answer 是从 1 开始的下标数组；第 2 题必须给 options。",
  ].join("\n");
}

/* ------------------------------------------------------------ 结果解析 */

/** 9 种题型与中文名（id → 题型顺序固定，模型漏给时用它兜底补齐） */
export const LANGUAGE_TYPES: { type: string; name: string; icon: string }[] = [
  { type: "word", name: "每日词语", icon: "sparkle" },
  { type: "word_collocation", name: "词语搭配", icon: "chinese" },
  { type: "sentence_expand", name: "扩句训练", icon: "pen" },
  { type: "sentence_correction", name: "病句修改", icon: "search" },
  { type: "sentence_detail", name: "把话写具体", icon: "eye" },
  { type: "sentence_order", name: "句子排序", icon: "list" },
  { type: "image_observation", name: "看图观察", icon: "eye" },
  { type: "image_speaking", name: "看图说话", icon: "speaker" },
  { type: "short_writing", name: "简短写作", icon: "pen" },
];

/** 交互方式：前三者可自动判卷，open 由孩子口述 + 家长判定 */
export type LanguageMode = "choice" | "fill" | "order" | "open";

export interface LanguageQuestion {
  id: number;
  type: string;
  typeName: string;
  icon: string;
  ability: string;
  subAbility: string;
  difficulty: number;
  mode: LanguageMode;
  /** 一句话说明这题怎么玩（服务端生成，前端直接用，避免前端硬编码题型文案） */
  howTo: string;
  question: string;
  /** 自动判卷的答案：choice/fill 是字符串；order 是正确顺序的句子数组 */
  answer: string | string[];
  /** 选择题候选（已打乱） */
  options: string[];
  /** 排序题的展示顺序（已打乱，即 sentences） */
  sentences: string[];
  /** 开放题的参考答案（人看的整段文字） */
  reference: string;
  /** 逐点参考答案（看图观察 / 看图说话，与问题一一对应） */
  referenceList: string[];
  guideQuestions: string[];
  word: string;
  meaning: string;
  collocation: string;
  example: string;
  baseSentence: string;
  wrongSentence: string;
  errorType: string;
  errorTypeName: string;
  orderType: string;
  fullParagraph: string;
  keywords: string[];
  requirements: Record<string, unknown> | null;
  imagePrompt: string;
  imageElements: Record<string, unknown> | null;
  observationQuestions: string[];
  hint: string;
  analysis: string;
  answerType: string;
  tags: string[];
}

export interface LanguageSet {
  date: string;
  theme: string;
  grade: number;
  difficulty: number;
  trainingGoal: string;
  questions: LanguageQuestion[];
  createdAt: string;
  model: string;
  ms: number;
}

const ERROR_TYPE_NAMES: Record<string, string> = Object.fromEntries(
  LANGUAGE_ERROR_TYPES.map((t) => [t.type, t.name]),
);

const ORDER_TYPE_NAMES: Record<string, string> = Object.fromEntries(
  LANGUAGE_ORDER_TYPES.map((t) => [t.type, t.name]),
);

/* -------- 取值小工具：模型字段时有时无、类型也飘，统一在这里兜住 -------- */

function asStr(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function asStrArr(v: unknown): string[] {
  if (!Array.isArray(v)) {
    const s = asStr(v);
    return s ? [s] : [];
  }
  return v.map(asStr).filter(Boolean);
}

function pickStr(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const s = asStr(o[k]);
    if (s) return s;
  }
  return "";
}

function pickArr(o: Record<string, unknown>, ...keys: string[]): string[] {
  for (const k of keys) {
    const a = asStrArr(o[k]);
    if (a.length) return a;
  }
  return [];
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Fisher–Yates，返回新数组 */
function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 从模型输出里抠出 JSON：容忍 Markdown 代码块、前后夹带的解释文字 */
export function extractJsonObject(raw: string): unknown {
  let t = String(raw ?? "").trim();
  if (!t) throw new LlmError("empty", "模型没有返回任何内容");

  // 去掉 ```json ... ``` 围栏
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  // 截取第一个 { 到最后一个 }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new LlmError("parse", "模型返回的内容里找不到 JSON 对象", { bodyHead: t.slice(0, 200) });
  }
  const slice = t.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (e) {
    throw new LlmError("parse", `模型返回的 JSON 无法解析：${(e as Error).message}`, {
      bodyHead: slice.slice(0, 200),
    });
  }
}

/** 归一一题；按 type 决定交互方式与字段 */
function normalizeQuestion(raw: Record<string, unknown>, index: number): LanguageQuestion {
  const id = Number.isFinite(Number(raw.id)) ? Math.trunc(Number(raw.id)) : index + 1;
  const def = LANGUAGE_TYPES[index] ?? { type: pickStr(raw, "type") || "unknown", name: "练习题", icon: "pen" };
  const type = pickStr(raw, "type") || def.type;

  const difficulty = Number.isFinite(Number(raw.difficulty)) ? Math.trunc(Number(raw.difficulty)) : 2;
  const base: LanguageQuestion = {
    id,
    type,
    typeName: def.name,
    icon: def.icon,
    ability: pickStr(raw, "ability"),
    subAbility: pickStr(raw, "subAbility"),
    difficulty: Math.min(5, Math.max(1, difficulty)),
    mode: "open",
    howTo: "读一读题目，想好以后说给大人听，由大人判断。",
    question: pickStr(raw, "question"),
    answer: "",
    options: [],
    sentences: [],
    reference: "",
    referenceList: [],
    guideQuestions: pickArr(raw, "guideQuestions"),
    word: pickStr(raw, "word"),
    meaning: pickStr(raw, "meaning"),
    collocation: pickStr(raw, "collocation"),
    example: pickStr(raw, "example"),
    baseSentence: pickStr(raw, "baseSentence"),
    wrongSentence: pickStr(raw, "wrongSentence"),
    errorType: pickStr(raw, "errorType"),
    errorTypeName: "",
    orderType: pickStr(raw, "orderType"),
    fullParagraph: pickStr(raw, "fullParagraph"),
    keywords: pickArr(raw, "keywords"),
    requirements: asObj(raw.requirements),
    imagePrompt: pickStr(raw, "imagePrompt"),
    imageElements: asObj(raw.imageElements),
    observationQuestions: pickArr(raw, "observationQuestions"),
    hint: pickStr(raw, "hint"),
    analysis: pickStr(raw, "analysis"),
    answerType: pickStr(raw, "answerType") || "reference",
    tags: pickArr(raw, "tags"),
  };

  switch (index) {
    /* 1. 每日词语 —— 认读 + 搭配 + 例句，孩子读熟后由家长判定 */
    case 0: {
      const word = base.word || pickStr(raw, "question");
      const meaning = base.meaning;
      const collocation = base.collocation;
      const example = base.example;
      base.question = base.question || `读一读词语「${word}」，说说它是什么意思，再说一个搭配。`;
      base.reference = [meaning && `解释：${meaning}`, collocation && `搭配：${collocation}`, example && `例句：${example}`]
        .filter(Boolean)
        .join("\n");
      base.howTo = "先大声读一遍词语、搭配和例句，再自己说一句带这个词的话。";
      break;
    }

    /* 2. 词语搭配 —— 有 options 就选择，没有就填空，两者都能自动判卷 */
    case 1: {
      const options = pickArr(raw, "options");
      const answer = pickStr(raw, "answer");
      base.options = options.length >= 2 ? shuffled(options) : [];
      base.answer = answer;
      if (base.options.length >= 2) {
        base.mode = "choice";
        base.howTo = "点一下你认为搭配正确的说法。";
      } else {
        base.mode = "fill";
        base.howTo = "把最合适的词语填进横线里。";
      }
      base.reference = answer;
      base.answerType = "standard";
      break;
    }

    /* 3. 扩句训练 —— 口述扩充，家长判定 */
    case 2: {
      base.question = base.question || "把下面的句子说得更具体。";
      base.reference = pickStr(raw, "answer");
      base.howTo = "照着提示的问题想一想，把句子说长一点、说具体一点。";
      break;
    }

    /* 4. 病句修改 —— 口述改后的句子，家长判定 */
    case 3: {
      base.errorTypeName = ERROR_TYPE_NAMES[base.errorType] ?? base.errorType;
      base.question = base.question || "读一读这句话，看看哪里不对，把它改通顺。";
      base.reference = pickStr(raw, "answer");
      base.howTo = "先找出哪里不对劲，再说出改好的句子。";
      break;
    }

    /* 5. 把话写具体 —— 口述具体表达，家长判定 */
    case 4: {
      base.question = base.question || "把这句话说得更具体，让人能「看见」你写的样子。";
      base.reference = pickStr(raw, "answer");
      base.howTo = "用动作、表情、声音或样子来描述，让大家看见画面。";
      break;
    }

    /* 6. 句子排序 —— 点句子按顺序排好，自动判卷 */
    case 5: {
      const raw5 = asStrArr(raw.sentences);
      const answerRaw = Array.isArray(raw.answer) ? (raw.answer as unknown[]) : [];
      let correct: string[] = [];
      let display: string[] = [];

      const nums = answerRaw.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (nums.length === answerRaw.length && nums.length >= 2 && raw5.length >= 2) {
        // 首选口径：answer 是从 1 开始的下标，sentences 是打乱后的句子
        correct = nums.map((n) => raw5[n - 1]).filter((s): s is string => typeof s === "string" && !!s);
        display = raw5;
      } else {
        const answerStr = asStrArr(raw.answer);
        const same = (a: string[], b: string[]): boolean =>
          a.length === b.length && a.every((x) => b.includes(x));
        if (answerStr.length >= 2 && same(answerStr, raw5)) {
          // 兜底一：answer 直接给了正确顺序的整句，sentences 是打乱的
          correct = answerStr;
          display = raw5;
        } else {
          // 兜底二：模型把 sentences 按正确顺序给了 —— 自己打乱，答案取原顺序
          correct = raw5;
          display = raw5.length > 1 ? shuffled(raw5) : raw5;
        }
      }

      if (display.length && correct.length && display.join("|") === correct.join("|") && display.length > 1) {
        display = shuffled(correct);
      }
      base.sentences = display;
      base.answer = correct;
      base.mode = "order";
      base.howTo = "按事情发生的顺序，依次点下面的句子。";
      base.reference = base.fullParagraph || correct.join("");
      base.answerType = "standard";
      break;
    }

    /* 7. 看图观察 —— 真实配图（文生图）+ 观察问题，答案逐条列出 */
    case 6: {
      base.question = base.question || "仔细看一看上面的图，再回答下面的问题。";
      base.referenceList = pickArr(raw, "answer");
      base.reference = base.referenceList.join("\n");
      base.howTo = "先仔细看图，再一个问题一个问题地说给大人听。";
      break;
    }

    /* 8. 看图说话 —— 复用第 7 题同一张图，口述一段话 */
    case 7: {
      base.question = base.question || "看着上面的图，用 3～5 句话把它说完整。";
      base.reference = pickStr(raw, "answer");
      base.howTo = "看着图，按提示的问题一段一段地说，最后连起来说一遍。";
      break;
    }

    /* 9. 简短写作 —— 按关键词/引导问题写（说）一小段 */
    default: {
      base.question = base.question || "按照要求，写一小段话。";
      base.reference = pickStr(raw, "answer");
      const req = base.requirements;
      const len = req ? asStr(req.suggestedLength) : "";
      base.howTo = len ? `写（或说）一段 ${len} 的话，写完读一遍给大人听。` : "写（或说）一小段话，写完读一遍给大人听。";
      break;
    }
  }

  if (!base.howTo) base.howTo = "读题后说给大人听，由大人判断。";
  return base;
}

/**
 * 解析模型输出 → 结构化的 9 题。
 * 校验：恰好 9 题、9 种题型齐全。缺题 / 题型不对直接抛 LlmError("parse")，
 * 由路由层重试一次；两次都不行才会把错误抛给家长。
 */
export function parseLanguageSet(
  raw: string,
  meta: { date: string; model: string; ms: number; difficulty: number; theme: string },
): LanguageSet {
  const obj = asObj(extractJsonObject(raw));
  if (!obj) throw new LlmError("parse", "模型返回的不是一个 JSON 对象");

  const rawQs = obj.questions;
  if (!Array.isArray(rawQs)) throw new LlmError("parse", "模型返回的 JSON 里没有 questions 数组");
  if (rawQs.length !== 9) {
    throw new LlmError("parse", `模型返回了 ${rawQs.length} 道题，要求恰好 9 道`);
  }

  // 按 type 归位（模型偶尔会打乱顺序，按 type 一一对应比按下标更稳）
  const byType = new Map<string, Record<string, unknown>>();
  const leftover: Record<string, unknown>[] = [];
  for (const q of rawQs) {
    const o = asObj(q);
    if (!o) continue;
    const t = pickStr(o, "type");
    if (t && !byType.has(t)) byType.set(t, o);
    else leftover.push(o);
  }

  const picked: Record<string, unknown>[] = [];
  for (const def of LANGUAGE_TYPES) {
    const hit = byType.get(def.type);
    if (hit) picked.push(hit);
    else if (leftover.length) picked.push(leftover.shift() as Record<string, unknown>);
    else throw new LlmError("parse", `缺少题型「${def.name}」（${def.type}）`);
  }

  const missing = LANGUAGE_TYPES.filter((def) => !byType.has(def.type)).map((d) => d.name);
  if (missing.length) {
    throw new LlmError("parse", `题型不全，缺少：${missing.join("、")}`);
  }

  const questions = picked.map((q, i) => normalizeQuestion(q, i));

  // 每题都必须有可展示的内容，否则孩子打开是一张空卡片
  const emptyIdx = questions.findIndex((q) => {
    if (q.mode === "order") return q.sentences.length < 2;
    if (q.mode === "choice") return q.options.length < 2 || !q.answer;
    return !(q.question || q.wrongSentence || q.baseSentence || q.imagePrompt);
  });
  if (emptyIdx >= 0) {
    throw new LlmError("parse", `第 ${emptyIdx + 1} 题（${questions[emptyIdx].typeName}）内容为空，无法出题`);
  }

  const difficulty = Number.isFinite(Number(obj.difficulty))
    ? Math.min(5, Math.max(1, Math.trunc(Number(obj.difficulty))))
    : meta.difficulty;

  // 主题以「我们请求的那一个」为准：系统提示词的示例里出现过 "今日主题" 这个占位词，
  // 模型偶尔会把它原样抄回来，那样孩子会看到「今日主题：今日主题」这种怪东西。
  const modelTheme = pickStr(obj, "theme");
  const theme = modelTheme && modelTheme !== "今日主题" ? modelTheme : meta.theme;

  return {
    date: meta.date,
    theme,
    grade: 2,
    difficulty,
    trainingGoal: pickStr(obj, "trainingGoal"),
    questions,
    createdAt: new Date().toISOString(),
    model: meta.model,
    ms: meta.ms,
  };
}
