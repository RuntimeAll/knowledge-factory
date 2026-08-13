/**
 * 产线出料 → kb-ingest/v1 转换器（AI:PRD-005 · 005-B）
 *
 * 🔴 纯函数测试：不碰库、不起模型、不跑侧车。转换层的全部职责就是**搬运**，
 *    所以这里钉的也全是「搬对了没有」：
 *
 *   ① 三形态各一例，料**取自真文件**（对象根/数组根/群卷题单，逐字抄的片段）；
 *   ② 🔴 题面一个字都不改（LaTeX 反斜杠、行内 span、全角标点原样穿过去）；
 *   ③ 🔴 未知字段如实进报告，不静默丢；
 *   ④ 归一每一条都记账（口算→计算 / 册级考点下沉 / 来源挂标签 / 实算不收）；
 *   ⑤ 认不出的形态一律抛，不猜。
 */
import { describe, expect, it } from "vitest";

import {
  ConvertError,
  convertPunchIngest,
  detectPunchForm,
  type ConvertResult,
} from "~/core";

// ---------------------------------------------------------------------------
// 料（🔴 逐字抄自真文件，只截了前两题；别"顺手"改成好看的样子）
//    对象根   举一反三产物/打卡/七上有理数与实数计算打卡/_源/_入库.json
//    数组根   举一反三产物/打卡/七上第二单元打卡册/_源/_入库.json
//    群卷题单 订阅特训/群打卡/第01期/绝对值压轴/第一天/题单.json
// ---------------------------------------------------------------------------

const 对象根 = {
  契约: "punch-ingest/v1",
  册: "有理数与实数计算打卡",
  类型: "打卡",
  科目: "数学",
  年级: "七上",
  源目录:
    "D:\\workplace\\ai-bkb\\举一反三产物\\打卡\\七上有理数与实数计算打卡\\_源",
  版本: [
    {
      版本名: "定版",
      layout_key: "two_col_spread",
      day_spec: { 天数: 10, 题数: 8 },
      题: [
        {
          day: 1,
          section: "有理数混合运算",
          seq: 1,
          stem: "\\left(\\frac{7}{9}-\\frac{5}{6}+\\frac{7}{18}\\right)\\times 2\\times 3^{2}-\\frac{7}{4}\\div\\left(-1.75\\right)",
          answer: "7",
          题型: "计算",
          来源: "母题=用户 2026-08-10 给的教辅照片 8 道题，参数化平行改编",
          实算: "绿",
        },
        {
          day: 1,
          section: "有理数混合运算",
          seq: 2,
          stem: "-1^{4}-\\left(1-0\\times 4\\right)\\div\\frac{1}{3}\\times\\left[\\left(-2\\right)^{2}-6\\right]-6",
          answer: "-1",
          题型: "计算",
          来源: "母题=用户 2026-08-10 给的教辅照片 8 道题，参数化平行改编",
          实算: "绿",
        },
      ],
    },
  ],
};

const 数组根 = [
  {
    契约: "punch-ingest/v1",
    册: "2.5 加减混合运算·凑整法与拆项法",
    组名: "七上第二单元打卡册",
    类型: "打卡",
    科目: "数学",
    年级: "七上",
    源目录: "D:\\workplace\\ai-bkb\\举一反三产物\\打卡\\七上第二单元打卡册",
    版本: [
      {
        版本名: "正册",
        layout_key: "textbook_spread",
        考点: ["凑整法", "拆项法", "有理数加减混合运算"],
        day_spec: { 天数: 10, 每天: { 口算: 6, 计算: 4 }, 题数: 100 },
        题: [
          {
            day: 1,
            section: "口算",
            seq: 1,
            stem: "(-10)+(+6)",
            answer: "-4",
            考点: null,
            题型: "口算",
            来源: "自编·2026-08·人教七上 2.5",
            实算: "绿",
          },
          {
            day: 1,
            section: "计算",
            seq: 2,
            stem: "(+12)+(-4)",
            answer: "8",
            考点: ["凑整法"],
            题型: "计算",
            来源: "自编·2026-08·人教七上 2.5",
            实算: "绿",
          },
        ],
      },
    ],
  },
  {
    // 🔴 合刊元素：登记型，**不挂题**（题在各成员册里）——它该被跳过，不是被判红
    契约: "punch-ingest/v1",
    册: "有理数运算一本通",
    册型: "合刊",
    组名: "七上第二单元打卡册",
    类型: "打卡",
    成员: ["有理数的加法", "带分数加法的简便运算"],
    交付件: [
      {
        版: "B版",
        角色: "题目卷",
        路径: "…\\_交付\\B版\\有理数运算一本通（题目卷）.pdf",
      },
    ],
    版本: [
      {
        版本名: "正册",
        layout_key: "textbook_spread",
        day_spec: { 天数: 26, 每天: {}, 题数: 334 },
        题: [],
      },
    ],
  },
];

const 群卷题单 = [
  {
    no: 1,
    q: '若 \\(\\left|x\\right|=\\left|-9\\right|\\)，则 \\(x=\\)<span style="display:inline-block;border-bottom:1px solid #000;min-width:5.4em"></span>。',
    ans: "\\(x=\\pm 9\\)",
    kp: ["abs"],
    diag: "",
    kp_group: "已知绝对值求数",
    anchor: "已知绝对值求数",
  },
  {
    no: 2,
    q: '绝对值不大于 \\(6.2\\) 的整数有 <span style="display:inline-block;border-bottom:1px solid #000;min-width:3.4em"></span> 个。',
    ans: "\\(13\\) 个",
    kp: ["abs"],
    diag: "漏掉 0 与负整数",
    kp_group: "已知绝对值求数",
    anchor: "已知绝对值求数",
  },
];

/** 深拷贝一份再改 —— 免得一条用例把料改坏了下一条不知道 */
function 拷<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function 唯一单元(r: ConvertResult) {
  expect(r.failed).toEqual([]);
  expect(r.units.length).toBe(1);
  return r.units[0]!;
}

// ---------------------------------------------------------------------------

describe("① 形态识别", () => {
  it("三种真料各认得出，认不出的一律抛（不猜）", () => {
    expect(detectPunchForm(对象根)).toBe("对象根");
    expect(detectPunchForm(数组根)).toBe("数组根");
    expect(detectPunchForm(群卷题单)).toBe("群卷题单");

    // 🔴 punch 那边的做法是「认不出的契约 console.log 跳过」，本层反过来
    expect(() =>
      detectPunchForm({ 契约: "punch-ingest/v0", 版本: [] }),
    ).toThrow(ConvertError);
    expect(() => detectPunchForm("一串字")).toThrow(/不是 JSON 对象/);
    expect(() => detectPunchForm([{ 随便: 1 }])).toThrow(/认不出|既不是/);
  });
});

describe("② 对象根（老形态）", () => {
  const r = convertPunchIngest(拷(对象根), {
    kps: ["有理数的混合运算"],
    source: "单测@1",
  });
  const u = 唯一单元(r);
  const items = u.payload.items;

  it("一册一单元；契约换成 kb-ingest/v1，源目录落 sourceDoc.path", () => {
    expect(r.form).toBe("对象根");
    expect(u.unit).toBe("有理数与实数计算打卡"); // 版本名=定版 不进单元名
    expect(u.payload.contract).toBe("kb-ingest/v1");
    expect(u.payload.source).toBe("单测@1");
    expect(u.payload.sourceDoc?.kind).toBe("册子"); // 类型「打卡」→ kind「册子」
    expect(u.payload.sourceDoc?.path).toContain("七上有理数与实数计算打卡");
    // 🔴 不给 hash：_入库.json 的内容 hash 会随「加了一天」变，
    //    给了就会同一册一天开一行 source_doc
    expect(u.payload.sourceDoc?.hash).toBeUndefined();
  });

  it("🔴 题面一个字都不改（LaTeX 反斜杠原样穿过去）", () => {
    expect(items[0]!.stem).toBe(对象根.版本[0]!.题[0]!.stem);
    expect(items[1]!.stem).toBe(对象根.版本[0]!.题[1]!.stem);
  });

  it("punchPos 保留（day/section/seq 三元组），批内 seq 用下标", () => {
    expect(items[0]!.punchPos).toEqual({
      day: 1,
      section: "有理数混合运算",
      seq: 1,
    });
    expect(items.map((i) => i.seq)).toEqual([1, 2]);
  });

  it("prov=pipeline，pipelineRef 推得出来且报告里说清楚是推的", () => {
    expect(items[0]!.prov.type).toBe("pipeline");
    expect(items[0]!.prov.pipelineRef).toContain("gen_打卡.py@");
    expect(items[0]!.prov.pipelineRef).toContain("有理数与实数计算打卡");
    expect(r.warnings.join("\n")).toContain("pipelineRef 是**推**出来的");
  });

  it("🔴 实算不收（产线自报的绿不作数），来源原话挂成标签", () => {
    // 整份 payload 里一个「实算」都不许有
    expect(JSON.stringify(u.payload)).not.toContain("实算");
    expect(r.normalizations.join("\n")).toContain("实算");
    expect(items[0]!.tags).toEqual([
      "来源:母题=用户 2026-08-10 给的教辅照片 8 道题，参数化平行改编",
    ]);
  });

  it("册级/题级都没考点时，用兜底考点并记账；主考点恰一个", () => {
    expect(items[0]!.kps).toEqual([
      { ref: "有理数的混合运算", isPrimary: true },
    ]);
    expect(r.normalizations.join("\n")).toContain("兜底考点");
  });

  it("没给兜底考点 ⇒ 判 NO_KP 不投（kb-ingest 禁孤题），而不是硬挂一个", () => {
    const 无 = convertPunchIngest(拷(对象根));
    expect(无.units).toEqual([]);
    expect(无.failed[0]?.code).toBe("NO_KP");
    expect(无.failed[0]?.seqs).toEqual([1, 2]);
  });
});

describe("③ 数组根（现行形态 + 合刊元素）", () => {
  const r = convertPunchIngest(拷(数组根), { source: "单测@2" });

  it("一管线一单元；合刊元素**跳过**（不挂题不是错）", () => {
    expect(r.form).toBe("数组根");
    expect(r.counts.units).toBe(1);
    expect(r.units[0]!.unit).toBe("2.5 加减混合运算·凑整法与拆项法·正册");
    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0]!.unit).toContain("有理数运算一本通");
    expect(r.skipped[0]!.why).toContain("一道题都没挂");
  });

  it("🔴 册级 版本[].考点 下沉到题级；题级自己有的以题级为准", () => {
    const items = r.units[0]!.payload.items;
    expect(items[0]!.kps.map((k) => k.ref)).toEqual([
      "凑整法",
      "拆项法",
      "有理数加减混合运算",
    ]);
    expect(items[0]!.kps.filter((k) => k.isPrimary).length).toBe(1);
    expect(items[1]!.kps.map((k) => k.ref)).toEqual(["凑整法"]);
    expect(r.normalizations.join("\n")).toContain("下沉到题级");
  });

  it("🔴 题型「口算」→ 字典值「计算」，且把「这会触发实算闸」写在账上", () => {
    expect(r.units[0]!.payload.items[0]!.qtype).toBe("计算");
    expect(r.normalizations.join("\n")).toContain("口算");
    expect(r.normalizations.join("\n")).toContain("实算闸");
  });

  it("交付件/组名/册型/成员 明确不收，并说明去哪儿了（🔴 提示不随被跳过的元素一起消失）", () => {
    expect(r.units[0]!.notes.join("\n")).toContain("不收");
    expect(JSON.stringify(r.units[0]!.payload)).not.toContain("册型");
    // 带「交付件」的正是那个被跳过的合刊元素 —— 提示必须升到全局 warnings，
    // 否则「这份料里有成品 PDF 指针没人管」这句话就跟着单元一起没了
    const w = r.warnings.join("\n");
    expect(w).toContain("交付件");
    expect(w).toContain("register_sku");
  });
});

describe("④ 群卷题单（字段名全不一样的那份）", () => {
  const r = convertPunchIngest(拷(群卷题单), {
    filePath:
      "D:/workplace/ai-bkb/订阅特训/群打卡/第01期/绝对值压轴/第一天/题单.json",
    punch: { day: 1, section: "绝对值压轴" },
    qtype: "填空",
  });
  const u = 唯一单元(r);
  const items = u.payload.items;

  it("no→seq / q→stem / ans→answer，题面里的行内 span 原样保留", () => {
    expect(items.map((i) => i.seq)).toEqual([1, 2]);
    expect(items[0]!.stem).toBe(群卷题单[0]!.q);
    expect(items[0]!.stem).toContain("<span");
    expect(items[0]!.answer).toBe("\\(x=\\pm 9\\)");
    expect(u.payload.sourceDoc?.kind).toBe("群卷");
  });

  it("🔴 kp（错因码）只进标签**不当考点**；考点 ref 取 anchor 送闸③精确匹配", () => {
    expect(items[0]!.tags).toContain("kp:abs");
    expect(items[0]!.tags).toContain("kp_group:已知绝对值求数");
    expect(items[0]!.tags).toContain("anchor:已知绝对值求数");
    expect(items[0]!.kps).toEqual([{ ref: "已知绝对值求数", isPrimary: true }]);
    expect(r.normalizations.join("\n")).toContain("不当考点挂载");
  });

  it("diag 本卡不入库，只留「有没有」的标记（内容是 006 错因域的料）", () => {
    expect(items[0]!.tags).not.toContain("diag:有"); // 第 1 题 diag=""
    expect(items[1]!.tags).toContain("diag:有"); // 第 2 题有内容
    expect(JSON.stringify(u.payload)).not.toContain("漏掉 0 与负整数");
  });

  it("位置补丁落 punchPos（day 由外面给，seq 用题号）", () => {
    expect(items[1]!.punchPos).toEqual({
      day: 1,
      section: "绝对值压轴",
      seq: 2,
    });
  });

  // ── kpMap（005-C）──────────────────────────────────────────────────────
  it("🔴 kpMap 命中就换 ref 并记账；表里没有的**照原样**送闸③（映射表不代替闸）", () => {
    const 料 = 拷(群卷题单) as unknown as Record<string, unknown>[];
    // 第 2 题换成一条「anchor 是 LaTeX、词表里绝无此名」的（真实形态：绝对值线节⑥）
    料[1]!.anchor = "\\(\\frac{\\left|a\\right|}{a}\\) 型的计算";
    料[1]!.kp_group = "\\(\\frac{\\left|a\\right|}{a}\\) 型的计算";
    const r2 = convertPunchIngest(料, {
      filePath: "D:/x/题单.json",
      qtype: "填空",
      kpMap: { "\\(\\frac{\\left|a\\right|}{a}\\) 型的计算": "符号商 |a|/a 型的计算" },
    });
    const it2 = 唯一单元(r2).payload.items;

    // 命中：ref 换成词表说法，并留一条 normalization（换过什么，账上写着）
    expect(it2[1]!.kps).toEqual([
      { ref: "符号商 |a|/a 型的计算", isPrimary: true },
    ]);
    expect(r2.normalizations.join("\n")).toContain("kpMap 显式映射");
    // 🔴 没命中的那条一个字不改 —— 映射表只解决「叫法对不上」，不代替闸③
    expect(it2[0]!.kps).toEqual([{ ref: "已知绝对值求数", isPrimary: true }]);
    // 原始说法照旧进标签，映射前的叫法查得到
    expect(it2[1]!.tags).toContain(
      "anchor:\\(\\frac{\\left|a\\right|}{a}\\) 型的计算",
    );
  });

  it("kpMap 也吃 anchor 为空的（退到 kp_group 查表）", () => {
    const 料 = 拷(群卷题单) as unknown as Record<string, unknown>[];
    料[0]!.anchor = ""; // 手写固定卷那两天就是这个形态
    料[0]!.kp_group = "小数运算与简算"; // 题组名，不是考点名
    const r2 = convertPunchIngest(料, {
      filePath: "D:/x/题单.json",
      kpMap: { 小数运算与简算: "分数与小数混合的有理数运算" },
    });
    expect(唯一单元(r2).payload.items[0]!.kps).toEqual([
      { ref: "分数与小数混合的有理数运算", isPrimary: true },
    ]);
  });
});

describe("⑤ 🔴 未知字段如实透传（不静默丢）", () => {
  it("册级/版本级/题级三层的生字都进 unknownFields，带样本值", () => {
    const 料 = 拷(对象根) as unknown as Record<string, unknown> & {
      版本: (Record<string, unknown> & { 题: Record<string, unknown>[] })[];
    };
    料.彩蛋册级 = "新加的册级字段";
    料.版本[0]!.彩蛋版本级 = { a: 1 };
    料.版本[0]!.题[0]!.彩蛋题级 = 42;

    const r = convertPunchIngest(料, { kps: ["有理数的混合运算"] });
    const 全 = r.unknownFields;
    const keys = 全.flatMap((u) => u.keys);
    expect(keys).toContain("彩蛋册级");
    expect(keys).toContain("彩蛋版本级");
    expect(keys).toContain("彩蛋题级");

    // 样本值要能让人一眼认出这是什么（不然「有个字段没搬」等于没说）
    expect(全.map((u) => u.sample).join("\n")).toContain("新加的册级字段");
    expect(全.map((u) => u.sample).join("\n")).toContain("42");
    // 位置说得出来
    expect(全.some((u) => u.where.includes("题[0]"))).toBe(true);

    // 🔴 生字**不会**被顺手塞进 payload（认不出的东西不入库）
    expect(JSON.stringify(r.units[0]!.payload)).not.toContain("彩蛋");
  });

  it("群卷题单的生字同样进报告", () => {
    const 料 = 拷(群卷题单) as unknown as Record<string, unknown>[];
    料[0]!.难度星 = 3;
    const r = convertPunchIngest(料, { filePath: "题单.json" });
    expect(r.unknownFields.flatMap((u) => u.keys)).toContain("难度星");
  });
});

describe("⑥ 自检闸", () => {
  it("转出来的 payload 一律先过 kb-ingest/v1 zod；没过的进 failed 不投", () => {
    const 料 = 拷(对象根);
    // 题面掏空 → 契约层 `stem 不能为空` 必须当场拦下
    料.版本[0]!.题[0]!.stem = "   ";
    const r = convertPunchIngest(料, { kps: ["有理数的混合运算"] });
    expect(r.units).toEqual([]);
    expect(r.failed[0]?.code).toBe("SCHEMA");
    expect(r.failed[0]?.message).toContain("stem");
  });
});
