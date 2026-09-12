/**
 * 种子数据：统编版语文二年级上册 14 篇课文的生字表
 *
 * 关于 word（组词）字段——这不是可有可无的装饰，而是**听写消歧的核心**：
 *   二年级听写真正的难点不是多音字本身（「发」读 fā 还是 fà，写出来都是「发」），
 *   而是**音近字混淆**：睛/晴、洋/阳、铜/同、桐/同。
 *   听写时先读词再读字（"眼睛……睛"），孩子才能确定是哪个字。
 *
 * 同时，word 也用来给单字生成拼音（见 services/pinyin.ts），
 * 所以像「发」这种多音字，这里填「头发」就能自动注成 fà 而不是 fā。
 */
export interface SeedChar {
  ch: string;
  word: string;
}

export interface SeedLesson {
  title: string;
  unit: string;
  note?: string;
  chars: SeedChar[];
}

export const SEED_LESSONS: SeedLesson[] = [
  {
    title: "《小蝌蚪找妈妈》",
    unit: "第一单元",
    chars: [
      { ch: "两", word: "两个" },
      { ch: "哪", word: "哪里" },
      { ch: "宽", word: "宽大" },
      { ch: "顶", word: "头顶" },
      { ch: "眼", word: "眼睛" },
      { ch: "睛", word: "眼睛" },
      { ch: "肚", word: "肚子" },
      { ch: "皮", word: "皮球" },
      { ch: "孩", word: "孩子" },
      { ch: "跳", word: "跳高" },
    ],
  },
  {
    title: "《我是什么》",
    unit: "第一单元",
    chars: [
      { ch: "变", word: "变化" },
      { ch: "极", word: "极小" },
      { ch: "片", word: "一片" },
      { ch: "傍", word: "傍晚" },
      { ch: "海", word: "大海" },
      { ch: "洋", word: "海洋" },
      { ch: "作", word: "作业" },
      { ch: "坏", word: "好坏" },
      { ch: "给", word: "送给" },
      { ch: "带", word: "带来" },
    ],
  },
  {
    title: "《植物妈妈有办法》",
    unit: "第一单元",
    chars: [
      { ch: "法", word: "办法" },
      { ch: "如", word: "如果" },
      { ch: "脚", word: "小脚" },
      { ch: "它", word: "它们" },
      { ch: "娃", word: "娃娃" },
      { ch: "她", word: "她们" },
      { ch: "毛", word: "毛茸茸" },
      { ch: "更", word: "更多" },
      { ch: "知", word: "知道" },
      { ch: "识", word: "认识" },
    ],
  },
  {
    title: "《场景歌》",
    unit: "第二单元（识字）",
    chars: [
      { ch: "园", word: "公园" },
      { ch: "孔", word: "孔雀" },
      { ch: "桥", word: "石桥" },
      { ch: "群", word: "一群" },
      { ch: "队", word: "队伍" },
      { ch: "旗", word: "红旗" },
      { ch: "铜", word: "铜号" },
      { ch: "号", word: "号角" },
      { ch: "领", word: "红领巾" },
      { ch: "巾", word: "毛巾" },
    ],
  },
  {
    title: "《树之歌》",
    unit: "第二单元（识字）",
    chars: [
      { ch: "杨", word: "杨树" },
      { ch: "壮", word: "粗壮" },
      { ch: "桐", word: "梧桐" },
      { ch: "枫", word: "枫树" },
      { ch: "松", word: "松树" },
      { ch: "柏", word: "柏树" },
      { ch: "棉", word: "棉花" },
      { ch: "杉", word: "水杉" },
      { ch: "化", word: "化石" },
      { ch: "桂", word: "桂花" },
    ],
  },
  {
    title: "《拍手歌》",
    unit: "第二单元（识字）",
    chars: [
      { ch: "歌", word: "唱歌" },
      { ch: "丛", word: "树丛" },
      { ch: "深", word: "深处" },
      { ch: "六", word: "六个" },
      { ch: "熊", word: "熊猫" },
      { ch: "猫", word: "小猫" },
      { ch: "九", word: "九个" },
      { ch: "朋", word: "朋友" },
      { ch: "友", word: "朋友" },
    ],
  },
  {
    title: "《田家四季歌》",
    unit: "第二单元（识字）",
    chars: [
      { ch: "季", word: "四季" },
      { ch: "吹", word: "吹风" },
      { ch: "肥", word: "肥料" },
      { ch: "农", word: "农民" },
      { ch: "忙", word: "帮忙" },
      { ch: "归", word: "归来" },
      { ch: "戴", word: "戴上" },
      { ch: "麦", word: "麦子" },
      { ch: "苗", word: "禾苗" },
      { ch: "桑", word: "桑叶" },
    ],
  },
  {
    title: "《曹冲称象》",
    unit: "第三单元",
    chars: [
      { ch: "曹", word: "曹冲" },
      { ch: "称", word: "称重" },
      { ch: "员", word: "官员" },
      { ch: "根", word: "树根" },
      { ch: "柱", word: "石柱" },
      { ch: "议", word: "议论" },
      { ch: "论", word: "讨论" },
      { ch: "重", word: "重量" },
      { ch: "杆", word: "秤杆" },
      { ch: "秤", word: "大秤" },
      { ch: "砍", word: "砍树" },
      { ch: "线", word: "直线" },
    ],
  },
  {
    title: "《玲玲的画》",
    unit: "第三单元",
    chars: [
      { ch: "玲", word: "玲玲" },
      { ch: "详", word: "详细" },
      { ch: "幅", word: "一幅画" },
      { ch: "评", word: "评比" },
      { ch: "奖", word: "奖励" },
      { ch: "催", word: "催促" },
      { ch: "啪", word: "啪嗒" },
      { ch: "脏", word: "弄脏" },
      { ch: "报", word: "报纸" },
      { ch: "另", word: "另外" },
      { ch: "及", word: "及时" },
      { ch: "懒", word: "懒洋洋" },
    ],
  },
  {
    title: "《一封信》",
    unit: "第三单元",
    chars: [
      { ch: "封", word: "信封" },
      { ch: "削", word: "削铅笔" },
      { ch: "锅", word: "下锅" },
      { ch: "朝", word: "朝向" },
      { ch: "叠", word: "叠被" },
      { ch: "刮", word: "刮风" },
      { ch: "胡", word: "胡须" },
      { ch: "灯", word: "电灯" },
      { ch: "修", word: "修理" },
      { ch: "冷", word: "寒冷" },
      { ch: "肩", word: "肩膀" },
      { ch: "团", word: "团圆" },
    ],
  },
  {
    title: "《妈妈睡了》",
    unit: "第三单元",
    chars: [
      { ch: "妈", word: "妈妈" },
      { ch: "哄", word: "哄睡" },
      { ch: "先", word: "先后" },
      { ch: "闭", word: "闭上" },
      { ch: "脸", word: "脸蛋" },
      { ch: "事", word: "故事" },
      { ch: "沉", word: "沉睡" },
      { ch: "发", word: "头发" },
      { ch: "窗", word: "窗户" },
      { ch: "沙", word: "沙沙" },
      { ch: "乏", word: "疲乏" },
    ],
  },
  {
    title: "《古诗二首（登鹳雀楼/望庐山瀑布）》",
    unit: "第四单元",
    chars: [
      { ch: "依", word: "依靠" },
      { ch: "尽", word: "尽头" },
      { ch: "欲", word: "欲望" },
      { ch: "穷", word: "无穷" },
      { ch: "层", word: "一层" },
      { ch: "瀑", word: "瀑布" },
      { ch: "布", word: "白布" },
      { ch: "炉", word: "火炉" },
      { ch: "烟", word: "烟雾" },
      { ch: "遥", word: "遥远" },
      { ch: "川", word: "山川" },
    ],
  },
  {
    title: "《黄山奇石》",
    unit: "第四单元",
    chars: [
      { ch: "闻", word: "闻名" },
      { ch: "名", word: "有名" },
      { ch: "景", word: "风景" },
      { ch: "区", word: "山区" },
      { ch: "省", word: "省份" },
      { ch: "部", word: "部分" },
      { ch: "秀", word: "秀丽" },
      { ch: "尤", word: "尤其" },
      { ch: "其", word: "其实" },
      { ch: "仙", word: "神仙" },
      { ch: "巨", word: "巨大" },
      { ch: "位", word: "位置" },
      { ch: "每", word: "每天" },
    ],
  },
  {
    title: "《日月潭》",
    unit: "第四单元",
    chars: [
      { ch: "潭", word: "水潭" },
      { ch: "湖", word: "湖水" },
      { ch: "绕", word: "围绕" },
      { ch: "茂", word: "茂盛" },
      { ch: "盛", word: "盛开" },
      { ch: "围", word: "周围" },
      { ch: "胜", word: "胜利" },
      { ch: "央", word: "中央" },
      { ch: "岛", word: "小岛" },
      { ch: "华", word: "中华" },
      { ch: "纱", word: "轻纱" },
      { ch: "童", word: "儿童" },
      { ch: "境", word: "环境" },
    ],
  },
];

export const SEED_STATS = {
  lessons: SEED_LESSONS.length,
  chars: SEED_LESSONS.reduce((n, l) => n + l.chars.length, 0),
};
