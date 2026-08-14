/**
 * 错因映射确认页的取数小工具（AI:PRD-008 · P2）
 *
 * 🔴 **只在 server 组件里 import**（它顺着 ~/core 拽 libsql；client 组件碰它会把
 *    数据库打进浏览器包）。给 client 的类型一律走 `./shared`。
 * 🔴 只读：三个函数全是 SELECT，一行都不写。
 * 🔴 为什么要现查一遍 (考点,码) 有没有映射：core 的 mapErrCode 撞键会抛 MAP_TAKEN
 *    （**故意不覆盖**），页面提前说清楚「这条已经指向谁了、要改判请走摘再挂」，
 *    比让人点下去吃一个错误码强。
 */
import { getCause, kpContext, listCauses } from "~/core";

export interface CauseOption {
  value: string;
  label: string;
  status: string | null;
  seedCode: string | null;
  desc: string | null;
}

/** 错因下拉的候选（含已退役的，但标出来 —— 退役错因不接新挂载，core 会拒） */
export async function causeOptions(): Promise<CauseOption[]> {
  const briefs = await listCauses({ limit: 500 });
  return briefs.map((b) => ({
    value: b.causeId,
    label: b.name,
    status: b.status,
    seedCode: b.seedCode,
    desc: b.desc,
  }));
}

export interface ExistingMap {
  causeId: string;
  causeName: string;
  causeStatus: string | null;
  seedCode: string | null;
  desc: string | null;
  mappedBy: string | null;
  mappedAt: string | null;
}

/**
 * 查 (考点, 码) 现在指向哪个错因。
 * 🔴 core 没有「列全部 err_code_map」的读函数，这里用 listCauses → getCause 拼
 *    （错因是个位数量级，本地库一次几毫秒）。长到几百条时该在 core 补一个。
 */
export async function findErrCodeMap(
  kpId: string,
  errCode: string,
): Promise<ExistingMap | null> {
  const briefs = await listCauses({ limit: 500 });
  for (const b of briefs) {
    const card = await getCause(b.causeId);
    const hit = card.errCodes.find(
      (m) => m.kpId === kpId && m.errCode === errCode,
    );
    if (hit) {
      return {
        causeId: b.causeId,
        causeName: b.name,
        causeStatus: b.status,
        seedCode: b.seedCode,
        desc: b.desc,
        mappedBy: hit.mappedBy,
        mappedAt: hit.mappedAt,
      };
    }
  }
  return null;
}

export interface KpBrief {
  kpId: string;
  name: string;
  status: string;
  /** 读不出来时的原文（考点 id 是人从别处粘来的，可能根本不存在） */
  error?: string;
}

/** kp_id → 名字（🔴 从库里读，不信 URL 上带的那个显示名） */
export async function describeKp(kpId: string): Promise<KpBrief> {
  try {
    const card = await kpContext(kpId);
    return {
      kpId: card.kp.id,
      name: card.kp.name,
      status: card.kp.status,
    };
  } catch (e) {
    return {
      kpId,
      name: "（查无此考点）",
      status: "?",
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}
