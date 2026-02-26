# Onboarding 国际化实现总结

## 已完成的工作

### 1. 创建 i18n 基础设施

创建了以下文件：

- `src/wizard/i18n/types.ts` - 定义了 i18n 类型接口
- `src/wizard/i18n/locales/en.ts` - 英文翻译
- `src/wizard/i18n/locales/zh-CN.ts` - 中文翻译
- `src/wizard/i18n/index.ts` - i18n 上下文创建和管理
- `src/wizard/i18n/i18n.test.ts` - 单元测试

### 2. 添加语言选择功能

在 `src/wizard/onboarding.ts` 中：

- 在 wizard 开始时添加了语言选择步骤
- 用户可以选择 English 或 中文 (简体)
- 创建了 `promptLanguageSelection()` 函数
- 将选中的语言传递到整个 onboarding 流程

### 3. 国际化核心文本

更新了以下模块的文本：

- Security warning (安全警告)
- Wizard intro (向导介绍)
- Flow selection (流程选择: QuickStart/Manual)
- Config handling (配置处理)
- Gateway setup (网关设置)
- Workspace configuration (工作区配置)
- Channel setup (频道设置)
- Skills setup (技能设置)

### 4. 更新相关文件

- `src/wizard/onboarding.ts` - 主要的 onboarding 逻辑
- `src/channels/plugins/onboarding-types.ts` - 添加 i18n 到 SetupChannelsOptions
- `src/commands/onboard-channels.ts` - 部分国际化（开始）

## 使用方法

### 运行 onboarding

当用户运行 `openclaw onboard` 时，会首先看到语言选择界面：

```
Select your language / 选择语言
> English
  中文 (简体)
```

选择语言后，所有后续的提示和消息都会使用所选语言显示。

### 添加新的翻译

1. 在 `src/wizard/i18n/types.ts` 中添加新的翻译键：

```typescript
export interface OnboardingTranslations {
  // ... existing keys
  newSection: {
    message: string;
    hint: string;
  };
}
```

2. 在 `src/wizard/i18n/locales/en.ts` 中添加英文翻译：

```typescript
export const en: OnboardingTranslations = {
  // ... existing translations
  newSection: {
    message: "Your message here",
    hint: "Your hint here",
  },
};
```

3. 在 `src/wizard/i18n/locales/zh-CN.ts` 中添加中文翻译：

```typescript
export const zh_CN: OnboardingTranslations = {
  // ... existing translations
  newSection: {
    message: "您的消息",
    hint: "您的提示",
  },
};
```

### 在代码中使用翻译

```typescript
// 在有 i18n 上下文的地方
const message = i18n.t.newSection.message;

// 在没有 i18n 上下文的地方（会默认使用英文）
const i18n = createI18nContext("en");
const message = i18n.t.newSection.message;
```

## 翻译覆盖范围

### 已完成

- ✅ 语言选择界面
- ✅ 安全警告
- ✅ Wizard 介绍
- ✅ 流程选择（QuickStart/Manual）
- ✅ 配置处理（Keep/Modify/Reset）
- ✅ 网关设置（Local/Remote）
- ✅ 网关配置选项（Port/Bind/Auth/Tailscale）
- ✅ 工作区目录提示
- ✅ 频道设置标题
- ✅ 技能设置标题
- ✅ 频道配置基础（部分）

### 待完成（如需要）

- ⏳ Channel setup 的详细配置流程
- ⏳ Skills setup 的详细配置流程
- ⏳ Auth choice 相关提示
- ⏳ Model picker 相关提示
- ⏳ 错误消息和警告
- ⏳ Remote gateway 配置
- ⏳ Windows 平台警告（在 onboard.ts 中）

## 技术细节

### 类型安全

所有翻译都是强类型的，TypeScript 会确保：

- 所有语言有相同的键结构
- 访问不存在的键时会报错
- 翻译值的类型正确

### 默认回退

如果没有提供 i18n 上下文，系统会自动回退到英文：

```typescript
const i18n = options?.i18n ?? createI18nContext("en");
```

### 测试

运行测试：

```bash
pnpm test src/wizard/i18n/i18n.test.ts
```

测试涵盖：

- 语言列表
- 翻译完整性
- 键结构一致性
- 默认回退行为

## 后续改进建议

1. **扩展语言支持**：可以添加更多语言（如 en, zh-CN, zh-TW, ja, ko 等）
2. **持久化语言选择**：将用户选择的语言保存到配置文件中
3. **命令行参数**：添加 `--lang` 参数允许跳过语言选择
4. **完整翻译**：完成所有子模块的翻译（channels, skills, auth, models 等）
5. **动态加载**：按需加载翻译文件以减小包体积
6. **翻译验证**：添加 CI 检查确保所有语言的键结构一致

## 示例截图（概念）

### 英文界面

```
Select your language / 选择语言
> English

╭───────────────────────────────────────╮
│                                       │
│   Welcome to OpenClaw Setup Wizard   │
│                                       │
╰───────────────────────────────────────╯

Onboarding mode
> QuickStart
  Manual
```

### 中文界面

```
Select your language / 选择语言
> 中文 (简体)

╭───────────────────────────────────────╮
│                                       │
│      欢迎使用 OpenClaw 配置向导       │
│                                       │
╰───────────────────────────────────────╯

引导配置模式
> 快速开始
  手动配置
```
