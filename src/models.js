export const MODEL_PRESETS = [
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    description: "当前 Codex CLI 默认模型，适合 ChatGPT 账号下的本地 Codex 工作流。",
    reasonings: [
      { level: "low", label: "Low", description: "响应最快，适合简单问答与轻量编辑。" },
      { level: "medium", label: "Medium", description: "推理深度与速度折中（默认）。" },
      { level: "high", label: "High", description: "更深推理，适合复杂修改。" },
      { level: "xhigh", label: "XHigh", description: "最高推理深度，适合疑难任务。" },
    ],
    defaultReasoning: "medium",
  },
  {
    id: "gpt-5-codex",
    label: "GPT-5-Codex",
    description: "面向复杂开发任务的旗舰 Codex，适合深度修改代码与调用多种工具。",
    reasonings: [
      { level: "low", label: "Low", description: "响应最快，推理深度最低，适合简单改动。" },
      { level: "medium", label: "Medium", description: "推理深度与速度折中（默认）。" },
      { level: "high", label: "High", description: "推理深度最高，适合疑难杂症与大型重构。" },
    ],
    defaultReasoning: "medium",
  },
  {
    id: "gpt-5-codex-mini",
    label: "GPT-5-Codex-Mini",
    description: "轻量版 Codex，适合日常增删改查与脚本编辑，成本更低。",
    reasonings: [
      { level: "low", label: "Low", description: "最快速的响应，适合简单编辑。" },
      { level: "medium", label: "Medium", description: "在速度与质量之间取得平衡（默认）。" },
    ],
    defaultReasoning: "medium",
  },
  {
    id: "gpt-5",
    label: "GPT-5",
    description: "通用型 GPT-5，覆盖广泛常识与自然语言任务，侧重综合推理。",
    reasonings: [
      { level: "low", label: "Low", description: "高速度模式，适合问答/总结等轻负载任务。" },
      { level: "medium", label: "Medium", description: "标准推理深度（默认），适合大多数对话场景。" },
      { level: "high", label: "High", description: "最大化推理能力，适合复杂需求或长篇创作。" },
    ],
    defaultReasoning: "medium",
  },
];

export function normalizeReasoning(value) {
  if (!value) return null;
  const lowered = String(value).toLowerCase();
  if (["minimal", "low", "medium", "high", "xhigh"].includes(lowered)) {
    return lowered;
  }
  return null;
}

export function getModelPreset(modelId) {
  if (!modelId) return null;
  const normalized = String(modelId).toLowerCase();
  return MODEL_PRESETS.find((preset) => preset.id === normalized) ?? null;
}

export function resolveModelAndReasoning({
  model,
  reasoning,
  defaultModel,
  defaultReasoning,
}) {
  if (!model) {
    return {
      resolvedModel: defaultModel,
      resolvedReasoning: defaultReasoning,
    };
  }

  const split = String(model).toLowerCase().split(":");
  const modelId = split[0];
  const appendedReasoning = split[1];
  const modelPreset = getModelPreset(modelId);
  const requestedReasoning = normalizeReasoning(reasoning ?? appendedReasoning);

  if (!modelPreset) {
    return {
      resolvedModel: modelId,
      resolvedReasoning: requestedReasoning ?? defaultReasoning,
    };
  }

  const allowedReasoning =
    requestedReasoning &&
    modelPreset?.reasonings?.some((r) => r.level === requestedReasoning)
      ? requestedReasoning
      : modelPreset?.defaultReasoning ?? defaultReasoning;

  return {
    resolvedModel: modelPreset?.id ?? defaultModel,
    resolvedReasoning: allowedReasoning,
  };
}

export function listModels(defaultModel, defaultReasoning) {
  const flattened = MODEL_PRESETS.flatMap((model) =>
    model.reasonings.map((reasoning) => ({
      object: "model",
      id: `${model.id}:${reasoning.level}`,
      label: `${model.label} · ${reasoning.label}`,
      description: `${model.description} (Reasoning: ${reasoning.label})`,
      base_model: model.id,
      reasoning: reasoning.level,
      default_reasoning: model.defaultReasoning,
    })),
  );

  return {
    object: "list",
    data: flattened,
    defaults: {
      model: `${defaultModel}:${defaultReasoning}`,
    },
  };
}
