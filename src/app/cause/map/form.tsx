"use client";

/**
 * 补映射 · 第一步：挑 (考点, 码)（AI:PRD-008 · P2）
 *
 * 🔴 本组件**不写库**：它只把选好的 (考点, 码) 拼进地址栏，
 *    第二步的预览页（server）再让人按确认。写只发生在那一下。
 * 🔴 考点用远程候选（/api/kp-options，`enqueue:false` 零写）：
 *    kp_id 一律 resolve 出来，禁手敲 —— 敲错一个字符就把错因挂到别的能力上了。
 */
import { Button, Input, Select, Space } from "antd";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import type { KpOption, KpOptionsResponse } from "~/app/question/shared";

export interface MapPickerProps {
  /** 从红旗队列点进来时带的初值 */
  kpId?: string;
  kpName?: string;
  errCode?: string;
}

export function MapPicker(props: MapPickerProps) {
  const router = useRouter();
  const [kpId, setKpId] = useState<string | undefined>(props.kpId);
  const [code, setCode] = useState<string>(props.errCode ?? "");
  const [options, setOptions] = useState<KpOption[]>(
    props.kpId && props.kpName
      ? [{ value: props.kpId, label: props.kpName, confidence: 1, via: "id" }]
      : [],
  );
  const [low, setLow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function searchKp(q: string): void {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/kp-options?q=${encodeURIComponent(q)}`);
          const j = (await res.json()) as KpOptionsResponse;
          setOptions(j.options);
          setLow(j.lowConfidence);
        } catch {
          setOptions([]);
        }
      })();
    }, 250);
  }

  const 可预览 = !!kpId && code.trim() !== "";

  return (
    <Space wrap size={8} align="start">
      <Select
        style={{ minWidth: 320 }}
        showSearch
        allowClear
        filterOption={false}
        onSearch={searchKp}
        onChange={(v: string | undefined) => setKpId(v)}
        value={kpId}
        placeholder="搜考点名 / 别名，选中才生效"
        options={options}
        notFoundContent={
          low ? "词表四路都没把握——候选只作参考，别硬挑一个" : "敲两个字试试"
        }
      />
      <Input
        style={{ width: 200 }}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="产线码，如 sign / dist / pow"
      />
      <Button
        type="primary"
        ghost
        disabled={!可预览}
        onClick={() =>
          router.push(
            `/cause/map?kp=${encodeURIComponent(kpId!)}&code=${encodeURIComponent(code.trim())}`,
          )
        }
      >
        下一步：预览
      </Button>
    </Space>
  );
}

export default MapPicker;
