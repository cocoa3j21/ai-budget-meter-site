/**
 * 各社標準AIモデル コスパ・単価ランキング (Standard AI Models Cost & Performance Ranking)
 * 開発者: cocoa3j21
 * 
 * 仕様特徴:
 * - 4大AI企業（OpenAI / Anthropic / Google / DeepSeek）の看板標準モデルに特化
 * - ネット生単価データ取得 & キャッシュ更新対応（OpenRouter公開エンドポイント / models_live.json）
 * - LMSYS Chatbot Arena等に基づく知能スコア（100点満点）
 * - 知能スコア × 生価格による「コスパ指数（0〜100点）」自動採点
 * - オフライン対応（内蔵マスターデータ ＆ localStorageキャッシュ）
 * - DOM API / textContent を用いたXSS対策
 */

(() => {
  'use strict';

  // 定数定義
  const RATE_STORAGE_KEY = 'cocoa3j21_model_rank_rate_v1';
  const MODELS_CACHE_STORAGE_KEY = 'cocoa3j21_standard_models_cache_v4';
  const MODELS_SYNC_TIME_KEY = 'cocoa3j21_standard_models_time_iso_v4';
  const DEALS_CACHE_STORAGE_KEY = 'cocoa3j21_deals_cache_v4';
  const DEALS_SYNC_TIME_KEY = 'cocoa3j21_deals_time_iso_v4';
  const DEFAULT_RATE = 155;
  const FETCH_TIMEOUT_MS = 8000;

  // 価格値の厳格なパースとバリデーション（要件1：型と空欄を厳格検証・Number()の罠排除）
  function parseStrictPrice(raw, allowZero = false) {
    // boolean, null, undefined は即時拒否
    if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
    // 配列・オブジェクトは Number() で 0 や数値になるため即時拒否
    if (typeof raw === 'object') return null;

    let num;
    if (typeof raw === 'number') {
      num = raw;
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed === '') return null; // 空文字・空白のみは拒否
      // 正確な数値表現（整数、小数、指数表記 e.g. 1.5e-6）のみ許可
      if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return null;
      num = Number(trimmed);
    } else {
      return null;
    }

    if (typeof num !== 'number' || isNaN(num) || !isFinite(num)) return null;

    if (allowZero) {
      if (num < 0) return null;
      return num; // 出力価格: 0 および "0" は許容（>= 0）
    } else {
      if (num <= 0) return null;
      return num; // 入力価格: 0円は対象外（> 0）
    }
  }

  function isValidPrice(val) {
    return parseStrictPrice(val, false) !== null;
  }

  function isValidOutputPrice(val) {
    return parseStrictPrice(val, true) !== null;
  }

  function validateModel(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
    if (typeof m.id !== 'string' || !m.id.trim()) return false;
    if (typeof m.name !== 'string' || !m.name.trim()) return false;
    if (!isValidPrice(m.inputPrice)) return false;
    if (!isValidOutputPrice(m.outputPrice)) return false;
    return true;
  }

  function validateModelList(list) {
    if (!Array.isArray(list) || list.length === 0) return null;
    const valid = [];
    for (const m of list) {
      if (!validateModel(m)) return null;
      valid.push({
        ...m,
        inputPrice: parseStrictPrice(m.inputPrice, false),
        outputPrice: parseStrictPrice(m.outputPrice, true),
        performanceScore: typeof m.performanceScore === 'number' && !isNaN(m.performanceScore) ? m.performanceScore : 80
      });
    }
    return valid;
  }

  // セール・特典データの厳格なスキーマ＆型検証（要件8：未知の項目は無視、既知項目の型検証）
  // 独自コスパ評価データのスキーマ検証（要件1: 3値・採点待ち対応）
  function validateTierData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (!Array.isArray(data.plans)) return null;
    const validPlans = [];
    for (const p of data.plans) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
      if (typeof p.plan_id !== 'string' || !p.plan_id) continue;
      if (typeof p.rank !== 'string') continue;
      validPlans.push(p);
    }
    if (validPlans.length === 0) return null;
    return {
      ...data,
      plans: validPlans
    };
  }

  // 独自コスパ評価データの読み込み（localStorage + subscriptions_tier.json）
  // JSON(subscriptions_tier.json / campaigns.json)の読込失敗を画面上部に通知する（成功時は何も出さない）
  const dataLoadStatus = { tier: true, campaigns: true };
  function updateDataLoadError() {
    const el = document.getElementById('data-load-error');
    if (!el) return;
    el.hidden = dataLoadStatus.tier && dataLoadStatus.campaigns;
  }

  // サブスク区分フィルタ判定（一覧の絞り込みと分類ボタンの件数計算で共用）
  function planMatchesSubTier(plan, key) {
    if (key === 'agent-all') return Boolean(plan.hasAgent);
    if (key === 'coding-agent') return plan.planGroup === 'coding-agent';
    if (key === 'native-agent') return plan.planGroup === 'native-agent';
    if (key === 'entry') return Boolean(plan.hasAgent) && plan.tier === 'entry';
    if (key === 'deal') return Boolean(plan.hasAgent) && Boolean(plan.deal && plan.deal.hasDeal);
    if (key === 'chat-only') return plan.planGroup === 'chat-only';
    return Boolean(plan.hasAgent);
  }

  // 分類ボタンの件数を実際のプラン数から自動計算して「ラベル (N)」に更新する
  function updateSubTabCount(tab, key) {
    const count = subscriptionPlans.filter(p => planMatchesSubTier(p, key)).length;
    const base = (tab.textContent || '').replace(/\s*\(\d+\)\s*$/, '').trim();
    tab.textContent = `${base} (${count})`;
  }

  // キャンペーンデータの読み込み（campaigns.json）
  async function loadCampaignsData() {
    try {
      const fresh = await fetchJsonWithTimeout('campaigns.json');
      if (fresh && Array.isArray(fresh.campaigns)) {
        campaignsData = fresh;
        dataLoadStatus.campaigns = true;
        renderSubscriptions();
      } else {
        dataLoadStatus.campaigns = false;
      }
    } catch (_) {
      dataLoadStatus.campaigns = false;
    }
    updateDataLoadError();
  }

  async function loadTierData() {
    try {
      const cached = localStorage.getItem('cocoa3j21_tier_evaluation_cache_v1');
      if (cached) {
        const parsed = JSON.parse(cached);
        const validated = validateTierData(parsed);
        if (validated) {
          tierEvaluationData = validated;
          renderSubscriptions();
        }
      }
    } catch (_) {}

    try {
      const fresh = await fetchJsonWithTimeout('subscriptions_tier.json');
      const validated = validateTierData(fresh);
      if (validated) {
        tierEvaluationData = validated;
        dataLoadStatus.tier = true;
        renderSubscriptions();
        try {
          localStorage.setItem('cocoa3j21_tier_evaluation_cache_v1', JSON.stringify(validated));
        } catch (_) {}
      } else {
        dataLoadStatus.tier = false;
      }
    } catch (_) {
      // オフラインや file:/// 時は画面上部に通知する
      dataLoadStatus.tier = false;
    }
    updateDataLoadError();
  }

  function validateDealsData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    let hasValidField = false;

    // トップレベルの既知キー検証
    const allowedTopKeys = ['subscriptions', 'models'];
    for (const k of Object.keys(data)) {
      if (!allowedTopKeys.includes(k)) {
        // 未知のトップレベル項目が存在する場合は拒否または無視
        continue;
      }
    }

    if (data.subscriptions !== undefined) {
      if (typeof data.subscriptions !== 'object' || Array.isArray(data.subscriptions) || data.subscriptions === null) {
        return false;
      }
      for (const key of Object.keys(data.subscriptions)) {
        const item = data.subscriptions[key];
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        if (item.badge !== undefined && typeof item.badge !== 'string') return false;
        if (item.badgeGeneral !== undefined && typeof item.badgeGeneral !== 'string') return false;
        if (item.badgeStudent !== undefined && typeof item.badgeStudent !== 'string') return false;
        if (item.freeTier !== undefined && typeof item.freeTier !== 'string') return false;
        if (item.annualDiscount !== undefined && typeof item.annualDiscount !== 'string') return false;
        if (item.studentDiscount !== undefined && typeof item.studentDiscount !== 'string') return false;
        if (item.specialDeal !== undefined && typeof item.specialDeal !== 'string') return false;
        if (item.hasDeal !== undefined && typeof item.hasDeal !== 'boolean') return false;
        hasValidField = true;
      }
    }

    if (data.models !== undefined) {
      if (typeof data.models !== 'object' || Array.isArray(data.models) || data.models === null) {
        return false;
      }
      for (const key of Object.keys(data.models)) {
        const item = data.models[key];
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        if (item.badge !== undefined && typeof item.badge !== 'string') return false;
        if (item.detail !== undefined && typeof item.detail !== 'string') return false;
        hasValidField = true;
      }
    }

    return hasValidField;
  }

  // 内蔵マスターデータ（2026年最新世代：各社を代表する看板標準8モデル）
  const DEFAULT_MODELS = [
    // 1. 各社 看板・主力フラッグシップ標準
    {
      id: 'anthropic/claude-sonnet-4.5',
      provider: 'Anthropic',
      name: 'Claude Sonnet 4.5',
      tier: 'flagship',
      tag: '💻 コーディング・自律エージェント対応',
      performanceScore: 97,
      inputPrice: 3.00,
      outputPrice: 15.00,
      deal: {
        badge: '⚡ キャッシュ90%OFF / Batch 50%OFF',
        detail: 'Prompt Cachingで入力 $0.30/1M、Batch API 50%OFF'
      }
    },
    {
      id: 'openai/gpt-5',
      provider: 'OpenAI',
      name: 'GPT-5 (Codex)',
      tier: 'flagship',
      tag: '🌐 万能推論・Codexエージェント標準',
      performanceScore: 96,
      inputPrice: 2.00,
      outputPrice: 8.00,
      deal: {
        badge: '⚡ キャッシュ75%OFF / Batch 50%OFF',
        detail: 'プロンプトキャッシュ命中時大幅割引、Batch API 50%OFF'
      }
    },
    {
      id: 'google/gemini-2.5-pro',
      provider: 'Google',
      name: 'Gemini 2.5 Pro',
      tier: 'flagship',
      tag: '📚 200万超長文・リポジトリ丸ごと解析',
      performanceScore: 95,
      inputPrice: 1.25,
      outputPrice: 5.00,
      deal: {
        badge: '📚 200万長文 / AI Studio無料枠',
        detail: 'コンテキストキャッシュ割引対応、Google AI Studio無料枠あり'
      }
    },
    {
      id: 'z-ai/glm-5',
      provider: 'Z.ai (Zhipu)',
      name: 'GLM-5 (Coding)',
      tier: 'flagship',
      tag: '🔥 エージェント特化・高キャッシュ還元',
      performanceScore: 92,
      inputPrice: 0.50,
      outputPrice: 2.00,
      deal: {
        badge: '🔥 キャッシュ高還元 / 激安主力',
        detail: 'プロンプトキャッシュ高ヒット率で実効単価が極めて安いコーディング主力モデル'
      }
    },
    {
      id: 'deepseek/deepseek-chat',
      provider: 'DeepSeek',
      name: 'DeepSeek-V3.2',
      tier: 'flagship',
      tag: '👑 圧倒的コスパ主力標準',
      performanceScore: 91,
      inputPrice: 0.14,
      outputPrice: 0.28,
      deal: {
        badge: '👑 キャッシュ90%OFF',
        detail: 'プロンプトキャッシュヒット時 入力 $0.014/1M (破格0.0014セント)'
      }
    },

    // 2. 各社 高速・軽量エントリー標準
    {
      id: 'anthropic/claude-haiku-4.5',
      provider: 'Anthropic',
      name: 'Claude Haiku 4.5',
      tier: 'light',
      tag: '✍️ 高速サブエージェント・高精度軽量',
      performanceScore: 88,
      inputPrice: 0.80,
      outputPrice: 4.00,
      deal: {
        badge: '⚡ キャッシュ90%OFF',
        detail: 'Prompt Cachingで入力 $0.08/1M、サブエージェント並列実行に最適'
      }
    },
    {
      id: 'openai/gpt-5-mini',
      provider: 'OpenAI',
      name: 'GPT-5-mini',
      tier: 'light',
      tag: '⚡ 高速・高信頼の軽量標準',
      performanceScore: 87,
      inputPrice: 0.15,
      outputPrice: 0.60,
      deal: {
        badge: '⚡ キャッシュ割引 / Batch 50%OFF',
        detail: '高速・低コストな軽量推論＆コーディング補助モデル'
      }
    },
    {
      id: 'google/gemini-2.5-flash',
      provider: 'Google',
      name: 'Gemini 2.5 Flash',
      tier: 'light',
      tag: '🚀 超爆安・大量処理特化',
      performanceScore: 86,
      inputPrice: 0.075,
      outputPrice: 0.30,
      deal: {
        badge: '🎁 AI Studio 15RPM無料枠',
        detail: 'Google AI Studioで無料枠あり、大量バッチ処理に最適'
      }
    }
  ];

  // 区分表示名マップ
  const TIER_NAMES = {
    flagship: '🏆 主力標準',
    light: '⚡ 軽量標準'
  };

  // 主要AI月額定額プラン（サブスク）マスターデータ
  // planGroup: 'coding-agent' (コーディング特化 6選) | 'native-agent' (本家・汎用＋Agent 3選) | 'chat-only' (チャットのみ別枠参考 3選)
  const SUBSCRIPTION_PLANS = [
    // ==========================================
    // 1. 💻 コーディング特化プラン（6選）
    // ==========================================
    {
      id: 'opencode-go',
      name: 'OpenCode Go',
      provider: 'OpenCode (Anomaly)',
      priceUSD: 10,
      priceLabel: '$10 / 月',
      priceNote: '上位Go Plus $40（初月割引は要確認）',
      apiEquivalent: '💡 参考枠: $60/月 (厳選モデル利用枠 / 未確認)',
      tokenRefresh: {
        type: 'monthly',
        badge: '📅 月次一括付与型 ($60枠)',
        desc: '月単位一括付与。月内使い切り時は追加チャージまたは翌月更新'
      },
      scoreBreakdown: { quota: 25, refresh: 6, agent: 30, price: 14, perk: 13 }, // 88点
      tier: 'entry',
      tierLabel: '💻 コーディング特化 ($10)',
      planGroup: 'coding-agent',
      category: 'coding',
      hasAgent: true,
      isBeginnerRecommended: true,
      agentBadge: '🤖 OpenCode / CLI接続',
      agentDesc: 'OpenCode等のターミナル自律エージェントで直接利用（月$60付与枠）',
      models: 'GLM-5, Kimi K2, DeepSeek-V3.2, Qwen 3 Coder, Grok 等',
      features: '月$10定額で厳選オープン・代替コーディングモデルを横断して大量に回せる統一API枠',
      target: '低価格で自律エージェントの利用を試したい開発者',
      badge: '🔥 廉価Agent筆頭',
      deal: {
        hasDeal: false,
        badge: '⚠️ 出典未確認: 初月$5の公式記載なし',
        annualDiscount: 'Go $10/月・Go Plus $40/月（公式確定）。初月$5・年払い割引は2026-11-16公式Goページで記載確認できず（要確認）',
        studentDiscount: 'OSS貢献者特典は公式記載確認できず（要確認）',
        freeTier: 'Free models（daily limit・公式）あり。CLI本体の永年無料はdocs側根拠（要確認）',
        specialDeal: '月$10で厳選モデル利用可。上限枠は現行$15〜$100相当（公式）',
        sourceUrl: 'https://opencode.ai/go',
        confirmedAt: '2026-11-16'
      }
    },
    {
      id: 'zai-glm-coding',
      name: 'GLM Coding Plan (Lite)',
      provider: 'Z.ai (Zhipu AI)',
      priceUSD: 18,
      priceLabel: '約$18 / 月',
      priceNote: '上位Proは約$30/月',
      apiEquivalent: '💡 利用枠: 月次トークンパック付与',
      tokenRefresh: {
        type: 'monthly',
        badge: '📅 月次一括＋キャッシュ還元',
        desc: '月次トークンパック制。プロンプトキャッシュ高ヒットで長持ち'
      },
      scoreBreakdown: { quota: 24, refresh: 6, agent: 30, price: 14, perk: 12 }, // 86点
      tier: 'entry',
      tierLabel: '💻 コーディング特化 ($18)',
      planGroup: 'coding-agent',
      category: 'coding',
      hasAgent: true,
      agentBadge: '🤖 Claude Code / OpenCode接続',
      agentDesc: 'Claude CodeやOpenCode、ZCodeのバックエンドとして接続し自律開発',
      models: 'GLM-5 / GLM-4.7 (フラッグシップCoding特化)',
      features: 'プロンプトキャッシュ高ヒット率＆ポイント制により、効率的に作業量を確保可能',
      target: 'Claude Code等のCLIエージェントに格安の頭脳（GLM-5）を繋いで開発したい人',
      badge: '⚡ トークン枠 (未確認)',
      deal: {
        hasDeal: false,
        badge: '⚠️ 出典未確認: 初回割引の公式記載なし',
        annualDiscount: 'Starting at just 18 USD per month（公式確定=$18）。四半期・年払い割引／上位Pro約$30は2026-11-16公式Overviewで記載確認できず（要確認）',
        studentDiscount: 'キャンペーン・学割の公式記載確認できず（要確認）',
        freeTier: '初回ボーナストークン枠の公式記載確認できず（要確認）',
        specialDeal: 'Claude Code/OpenCode/ZCode等20+ツール対応（公式）。Lite=5時間2,000・週次10,000クレジット、off-peak 50%減（公式）',
        sourceUrl: 'https://docs.z.ai/devpack/overview.md',
        confirmedAt: '2026-11-16'
      }
    },
    {
      id: 'kimi-coding',
      name: 'Kimi Plus (K2 Coding枠)',
      provider: 'Moonshot AI',
      priceUSD: 10,
      priceLabel: '約$10 / 月',
      priceNote: 'プラン/チャージ特典あり',
      apiEquivalent: '💡 利用枠: 月次パッケージ枠付与',
      tokenRefresh: {
        type: 'monthly',
        badge: '📅 月次一括 / チャージ型',
        desc: '月次枠制。超過時はパッケージ追加チャージ'
      },
      scoreBreakdown: { quota: 21, refresh: 6, agent: 29, price: 14, perk: 10 }, // 80点
      tier: 'entry',
      tierLabel: '💻 コーディング特化 (要確認)',
      planGroup: 'coding-agent',
      category: 'coding',
      hasAgent: true,
      agentBadge: '🤖 Kimi CLI / CC互換接続',
      agentDesc: 'Claude Code互換APIやOpenCodeからKimi K2を駆動して自律コーディング',
      models: 'Kimi K2 Thinking / Kimi K2 Coding',
      features: '長文コンテキストとエージェント推論に強いKimi K2系を低価格でコーディングツールに統合',
      target: 'Kimi K2の高いコーディング推論力を安価な定額・パッケージ枠で活用したい開発者',
      badge: '🌙 K2エージェント対応',
      deal: {
        hasDeal: false,
        badge: '⚠️ 国際価格の公式記載なし（中国向け¥99/¥948年のみ確定）',
        annualDiscount: '中国向け Plus ¥99/月・¥948/年（月換算¥79・公式）。日本/USD価格・$10〜12相当は2026-11-16公式ヘルプで記載確認できず（要確認）',
        studentDiscount: 'なし（公式記載なし）',
        freeTier: '無料トライアル枠の公式記載なし（要確認）',
        specialDeal: 'Plus以上でKimi Code利用可・5時間ローリング制限（公式）。月次共有クレジット・繰り越しなし（公式）',
        sourceUrl: 'https://www.kimi.com/en/help/membership/membership-pricing',
        confirmedAt: '2026-11-16'
      }
    },
    {
      id: 'github-copilot',
      name: 'GitHub Copilot Pro',
      provider: 'GitHub / Microsoft',
      priceUSD: 10,
      priceLabel: '$10 / 月',
      priceNote: '年払いは$100/年 (月$8.33)',
      apiEquivalent: '💡 利用枠: エージェント等の対象機能は月1,500 AIクレジット。コード補完の無制限提供とは別',
      tokenRefresh: {
        type: 'auto',
        badge: '🔄 コード補完無制限 ＋ 月1,500クレジット',
        desc: 'コード補完は無制限提供。エージェント等の対象機能は毎月1日00:00 UTCに1,500 AIクレジットが付与（繰越不可）'
      },
      scoreBreakdown: { quota: 20, refresh: 2, agent: 25, price: 24.15, perk: 0 },
      tier: 'entry',
      tierLabel: '💻 コーディング特化 ($10)',
      planGroup: 'coding-agent',
      category: 'coding',
      hasAgent: true,
      isVerificationTarget: true,
      isBeginnerRecommended: false,
      agentBadge: '🤖 Copilot Agent / Edits',
      agentDesc: 'VS Code / JetBrains / CLIでの自律Agentモード・マルチファイル編集・PR支援',
      models: '',
      features: 'IDEでの自律Agentモード、マルチファイル編集、コード補完に対応。エージェント等の対象機能は月1,500 AIクレジットが付与され、コード補完は無制限提供',
      target: 'VS CodeやJetBrains等のIDEで自律Agentモードやコード補完を利用したい開発者',
      badge: '💻 公式検証対象',
      badgeGeneral: '💻 公式検証対象',
      badgeStudent: '🎓 公式検証対象 / 学割対象',
      deal: {
        hasDeal: false,
        badge: '⚠️ 個人年払$100は公式ページ記載なし（要確認）/ Copilot Student無料はEducation原文で確定',
        badgeGeneral: '⚠️ 年払割引は公式pricing/plans/docsに記載なし（要確認）',
        badgeStudent: '🎓 GitHub Copilot Student 無料アクセス（公式原文）/ 期間・プラン内容は要確認',
        annualDiscount: 'Pro $10 USD per user/month・Pro+ $39・Max $100（公式確定）。個人年払い$100/年（月$8.33・17%OFF）の記載は2026-11-16にfeatures/copilot/plansとdocs.github.com/en/copilot/get-started/plansの両方で確認できず（要確認）',
        studentDiscount: 'Verified students have access to the GitHub Copilot Student plan（features/copilot/plans原文）＋GitHub Education原文「free access to the same tools professional developers use, including GitHub Copilot Student」（2026-11-16 education.github.com/benefits確認）。対象=学生認証は確定。期間・更新条件・プラン階層（Pro/Pro+相当）の原文なし=要確認',
        freeTier: 'Free $0: 2,000 completions per month（公式）',
        specialDeal: '3rd party agents (Claude Code/Codex)・Model selection・$15 credits（Pro・公式）',
        sourceUrl: 'https://github.com/features/copilot/plans',
        confirmedAt: '2026-11-16',
        verificationNote: '2026-11-16三出典確認: features/copilot/plans（Pro $10・Student plan言及）、education.github.com/benefits（Copilot Student無料アクセス原文）、docs.github.com/en/copilot/get-started/plans（年払記載なし）。個人年払・Student期間/階層=要確認'
      }
    },
    {
      id: 'windsurf',
      name: 'Windsurf Pro',
      provider: 'Codeium (Windsurf)',
      priceUSD: 20,
      priceLabel: '$20 / 月',
      priceNote: '公式 pricing の Pro は $20/月',
      apiEquivalent: '💡 利用枠: 日次・週次のクォータ（数値は公式に非公表）',
      tokenRefresh: {
        type: 'weekly',
        badge: '📅 日次・週次クォータ制',
        desc: '公式に「daily and weekly usage allowance that refreshes automatically」と明記'
      },
      scoreBreakdown: { quota: 10, refresh: 3, agent: 25, price: 13.3, perk: 0 },
      tier: 'standard',
      tierLabel: '💻 コーディング特化 ($20)',
      planGroup: 'coding-agent',
      category: 'coding',
      hasAgent: true,
      agentBadge: '🤖 Cascade 自律Agent',
      agentDesc: 'Cascade協調フローエージェントによるリポジトリ把握・複数ファイル自律編集・コマンド実行',
      models: 'Claude Sonnet 4.5, GPT-5, DeepSeek-V3.2 等',
      features: '次世代AIネイティブIDE。日次・週次クォータ制でコンテキスト認識と自律実行の完成度が高い',
      target: '高品質なAIエディタ＆エージェント環境を月$20で使いたい人',
      badge: '🌊 AIネイティブIDE',
      deal: {
        hasDeal: false,
        badge: '',
        annualDiscount: '要確認（2026-11-16 公式Pricingに年払い$150/17%OFFの記載なし）',
        studentDiscount: '要確認（公式記載なし）',
        freeTier: 'Free $0（Light quota・Limited model availability）',
        specialDeal: '上限到達時は Pro では追加購入（Purchase extra usage at API pricing）で継続（公式）',
        sourceUrl: 'https://windsurf.com/pricing',
        confirmedAt: '2026-11-16'
      }
    },
    {
      id: 'cursor-plus',
      name: 'Cursor Plus (The X Subscription)',
      provider: 'Anysphere',
      priceUSD: 8,
      priceLabel: '$8 / 月',
      priceNote: '年払い $80/年（Help Docs記載）',
      apiEquivalent: '💡 利用枠: Shared AI usage pool（Base・数値非公表・PlusではCursorモデルのみ。サードパーティモデルは含まれない）。利用枠を使い切った場合はtop-upsを購入するか、週次プールの回復を待つ（Help Docs / 2026-11-14確認）',
      tokenRefresh: {
        type: 'weekly',
        badge: '📅 週次回復制 (Shared pool)',
        desc: '公式ヘルプに基づき毎週回復する利用プール（Shared AI usage pool）。回復量は量未確認。利用枠を使い切った場合はtop-upsを購入するか、週次プールの回復を待つ（Help Docs / 2026-11-14確認）'
      },
      scoreBreakdown: { quota: 10, refresh: 3, agent: 25, price: 26.32, perk: 0 },
      tier: 'entry',
      tierLabel: '💻 コーディング特化 ($8)',
      planGroup: 'coding-agent',
      category: 'coding',
      hasAgent: true,
      agentBadge: '🤖 エディター内Agent（Cursor独自モデル）',
      agentDesc: 'エディター内のAgentは利用可。除外されるのは Auto / Cloud Agents（別機能）/ Automations / Bugbot / Origin / サードパーティモデル（公式）',
      models: 'Grok 4.7 / Grok 4.6 / Grok 4.5 / Composer 2.5（Fast off・medium effort 固定）',
      features: 'Cursor モデルの週次プールを最安値で使える新規向けエントリープラン',
      target: 'まず安価に Cursor のモデルを使いたい新規ユーザー',
      badge: '🆕 新規向けエントリー',
      deal: {
        hasDeal: false,
        badge: '',
        annualDiscount: '年払い $80/年（Help Docs記載）',
        studentDiscount: '要確認',
        freeTier: 'Free $0（Limited）',
        specialDeal: 'Auto / Cloud Agents / サードパーティモデルは非対応（Premium 以上で利用可）'
      }
    },
    {
      id: 'cursor-premium',
      name: 'Cursor Premium (The X Subscription)',
      provider: 'Anysphere',
      priceUSD: 30,
      priceLabel: '$30 / 月',
      priceNote: '年払い $300/年（公式）',
      apiEquivalent: '💡 利用枠: Cursor 独自モデル(Grok/Composer)の週次プール（Plus の4倍・数値は非公表・Claude/GPT/Gemini は含まれない）',
      tokenRefresh: {
        type: 'weekly',
        badge: '📅 週次プール制（4x Plus）',
        desc: '全有料プランに Cursor モデル用の週次プールが付与される（公式）'
      },
      scoreBreakdown: { quota: 10, refresh: 3, agent: 25, price: 2.45, perk: 0 },
      tier: 'standard',
      tierLabel: '💻 コーディング特化 ($30)',
      planGroup: 'coding-agent',
      category: 'coding',
      hasAgent: true,
      agentBadge: '🤖 Cursor Agent / Cloud Agents',
      agentDesc: 'Auto・Cloud Agents・Automations・Bugbot・Origin・サードパーティモデルを利用可能（公式）',
      models: 'Grok 4.7 / Grok 4.6 / Grok 4.5 / Composer 2.5 ＋ サードパーティモデル（API定価・プリペイド）',
      features: 'Cursor の全エージェント機能とサードパーティモデルを使える上位プラン',
      target: 'Cursor のエージェント機能をフルに使いたい開発者',
      badge: '⚡ フル機能',
      deal: {
        hasDeal: false,
        badge: '',
        annualDiscount: '年払い $300/年（公式）',
        studentDiscount: '要確認',
        freeTier: 'Free $0（Limited）',
        specialDeal: 'サードパーティモデルは API 定価でプリペイドクレジットから支払い'
      }
    },
    {
      id: 'cursor-pro',
      name: 'Cursor Pro (Legacy・既存契約者向け)',
      provider: 'Anysphere',
      priceUSD: 20,
      priceLabel: '$20 / 月',
      priceNote: '新規契約不可（既存契約者のみ維持）',
      apiEquivalent: '💡 利用枠: 要確認（Legacy のため新規向け比較の対象外）',
      tokenRefresh: {
        type: 'monthly',
        badge: '📅 月次2プール制（Legacy）',
        desc: 'Legacy プランは Cursor Models と Other Models の月次2プール制（公式）'
      },
      scoreBreakdown: { quota: 19, refresh: 9, agent: 35, price: 10, perkGeneral: 11, perkStudent: 12, perk: 11 },
      tier: 'standard',
      tierLabel: '💻 コーディング特化 (Legacy)',
      planGroup: 'coding-agent',
      category: 'coding',
      hasAgent: true,
      agentBadge: '🤖 Cursor Agent / Composer',
      agentDesc: 'Composer / Agentモードによるコードベース全体の自律修正・ターミナル実行・高精度Tab補完',
      models: 'Claude Sonnet 4.5 / Opus 4.6, GPT-5, Gemini 2.5 Pro, Cursor-Fast',
      features: 'AIエディタのデファクト標準。複数ファイルの自律一括改修と圧倒的なUI操作性',
      target: '既存の Legacy Pro 契約者（新規契約は不可）',
      badge: '📦 既存契約者向け',
      deal: {
        hasDeal: false,
        badge: '',
        annualDiscount: '要確認（Legacy のため新規向け比較の対象外）',
        studentDiscount: '要確認',
        freeTier: '要確認',
        specialDeal: '公式に「They aren\'t available to new customers, but existing subscribers keep them until they switch or cancel」と明記',
        sourceUrl: 'https://cursor.com/help/account-and-billing/pricing',
        confirmedAt: '2026-11-16',
        verificationNote: '2026-11-16 Help Docs/Pricing確認: Legacy Pro $20/mo・Premium相当・年払$192/14日トライアル/学割の公式記載なし=要確認'
      }
    },

    // ==========================================
    // 2. 👑 本家・汎用＋エージェント付プラン（3選）
    // ==========================================
    {
      id: 'claude-pro',
      name: 'Claude Pro',
      provider: 'Anthropic',
      priceUSD: 20,
      priceLabel: '$20 / 月',
      priceNote: '年払いは月換算 約$17〜$18',
      apiEquivalent: '💡 利用枠: 5時間毎のリセット枠 ＋ Claude Code',
      tokenRefresh: {
        type: 'auto',
        badge: '🔄 5時間毎にリセット',
        desc: '5時間ごとのローリング制限。5時間経過後に利用枠が更新されます'
      },
      scoreBreakdown: { quota: 19, refresh: 10, agent: 35, price: 10, perk: 12 }, // 86点
      tier: 'standard',
      tierLabel: '👑 汎用＋Agent ($20)',
      planGroup: 'native-agent',
      category: 'native',
      hasAgent: true,
      isBeginnerRecommended: true,
      agentBadge: '🤖 Claude Code 標準付帯',
      agentDesc: 'ターミナル自律エージェントの決定版「Claude Code」をサブスク枠内で直接利用可能',
      models: 'Claude Sonnet 4.5 / Opus 4.6 / Haiku 4.5',
      features: 'Webチャット・Projects・Artifactsに加え、CLIエージェント「Claude Code」が使えるプラン（※5時間ごとの枠制限あり / 未確認）',
      target: 'Claude Codeと、日常の高度な文章推敲・壁打ちを両立したい人',
      badge: '🧠 Claude Code対応',
      deal: {
        hasDeal: true,
        badge: '🔥 年払割（前払$200・月換算$17・公式原文）',
        annualDiscount: 'Pro: $20 if billed monthly／年払契約は月換算$17・前払$200（公式原文）。旧『約$17〜18・約17%OFF』は公式原文にない計算値のため要確認',
        studentDiscount: '学生向けPro価格割引の公式記載確認できず（要確認）',
        freeTier: 'Free $0（公式）※Claude Code利用にはPro以上またはAPIが必要',
        specialDeal: 'Claude CodeはPro以上で利用可（公式）。5時間ごとリセット制',
        sourceUrl: 'https://claude.com/pricing',
        confirmedAt: '2026-11-16',
        verificationNote: '2026-11-16 公式Pricing原文確認: $20 if billed monthly / $17 Per month with annual subscription discount ($200 billed up front)。学割Pro価格の記載なし=要確認'
      }
    },
    {
      id: 'chatgpt-plus',
      name: 'ChatGPT Plus',
      provider: 'OpenAI',
      priceUSD: 20,
      priceLabel: '$20 / 月',
      priceNote: '日本国内 約3,000円/月',
      apiEquivalent: '💡 利用枠: メッセージ数制限 (3時間リセット)',
      tokenRefresh: {
        type: 'auto',
        badge: '🔄 3時間毎にリセット',
        desc: '3時間ローリング回復。メッセージ制限が数時間ごとに随時リセット'
      },
      scoreBreakdown: { quota: 18, refresh: 8, agent: 32, price: 10, perk: 9 }, // 77点
      tier: 'standard',
      tierLabel: '👑 汎用＋Agent ($20)',
      planGroup: 'native-agent',
      category: 'native',
      hasAgent: true,
      agentBadge: '🤖 Codex 利用権付帯 (未確認)',
      agentDesc: '自律コーディングエージェント「Codex (CLI / サンドボックス)」利用権を包括（※最新仕様未確認）',
      models: 'GPT-5, o3, OpenAI Codex, GPT-5-mini',
      features: 'Web検索・Deep Research・画像生成・高度音声対話に加え、Codexエージェントが利用可能（※未確認）',
      target: '普段使いの万能AI環境と、Codexコーディングエージェントを1つにまとめたい人',
      badge: '🌐 Codex対応 (未確認)',
      deal: {
        hasDeal: false,
        badge: '🌐 Codexエージェント枠付帯',
        annualDiscount: '個人Plusは月払い$20のみ（Teamプランは年払い割引あり）',
        studentDiscount: 'ChatGPT Edu（大学機関向け）',
        freeTier: '無料枠でGPT-5軽量版・検索・音声利用可',
        specialDeal: '自律コーディングエージェント「Codex (CLI / サンドボックス)」の利用権が付帯（※未確認）'
      }
    },
    {
      id: 'google-ai-pro',
      name: 'Google AI Pro (旧Advanced)',
      provider: 'Google',
      priceUSD: 19.99,
      priceLabel: '$19.99 / 月',
      priceNote: '日本円定価 2,900円/月',
      apiEquivalent: '💡 利用枠: Gemini Advanced ＋ 2TB Google One',
      tokenRefresh: {
        type: 'auto',
        badge: '🔄 日次リセット制＋15RPM無料枠',
        desc: '日次レートリセット。AI Studio 15RPM無料枠も併用可能'
      },
      scoreBreakdown: { quota: 18, refresh: 8, agent: 30, price: 10, perk: 14 }, // 80点
      tier: 'standard',
      tierLabel: '👑 汎用＋Agent ($19.99)',
      planGroup: 'native-agent',
      category: 'native',
      hasAgent: true,
      agentBadge: '🤖 Gemini CLI / Jules連携',
      agentDesc: 'Gemini CLIおよび非同期コーディングエージェント「Jules」の高レート枠＋長文解析',
      models: 'Gemini 2.5 / 3.0 Pro (最大200万トークン)',
      features: 'Googleドライブ 2TBストレージ付属、Gmail/Docs統合、超巨大コンテキストによるリポジトリ丸ごと分析',
      target: 'Google Drive 2TB容量やWorkspace連携を活用しつつ、大規模コードベースを解析させたい人',
      badge: '📦 2TB＋Gemini Agent',
      deal: {
        hasDeal: false,
        badge: '⚠️ 初月無料・年額16%OFFは公式記載なし（要確認）',
        annualDiscount: 'Google AI Pro ￥2,900 JPY/月（公式確定）。年額一括16%OFF・初月無料は2026-11-16公式ページで記載確認できず（要確認）',
        studentDiscount: '学生向け割引価格の公式記載確認できず（要確認）',
        freeTier: '無料 ￥0 JPY/月（公式）＋Google AI Studio無料枠（トライアル原文は要確認）',
        specialDeal: '5TBストレージ・YouTube Premium Lite・Gemini 4 Argonアクセス（公式）',
        sourceUrl: 'https://gemini.google/subscriptions/',
        confirmedAt: '2026-11-16',
        verificationNote: '2026-11-16 日本地域公式ページ確認: ¥2,900/月確定。初月無料・年額16%OFF・学生割引の記載なし=要確認'
      }
    },

    // ==========================================
    // 3. 💬 チャットのみ・ライト枠（別枠参考・3選）
    // ※メイン比較からは除外し、「💬 チャットのみ・ライト枠」タブ選択時のみ表示
    // ==========================================
    {
      id: 'google-ai-plus',
      name: 'Google AI Plus (廉価ライト)',
      provider: 'Google',
      priceUSD: 5,
      priceLabel: '約$5〜$8 / 月',
      priceNote: '日本円 約725円〜1,200円/月',
      apiEquivalent: '💡 利用枠: Geminiアクセス ＋ 200GB Google One',
      tokenRefresh: {
        type: 'auto',
        badge: '🔄 日次レートリミット制',
        desc: '日次でリセットされるチャット枠'
      },
      scoreBreakdown: { quota: 19, refresh: 8, agent: 18, price: 15, perk: 13 }, // 73点
      tier: 'chat-light',
      tierLabel: '💬 チャットのみ (廉価)',
      planGroup: 'chat-only',
      category: 'chat',
      hasAgent: false,
      agentBadge: '💬 チャット・連携専用 (Agentなし)',
      agentDesc: 'Web対話・Deep Research・Gmail/Docs連携の制限緩和用（自律コーディング枠は対象外）',
      models: 'Gemini 2.5 Pro / Flash',
      features: '月額700円台〜という圧倒的安さでGemini上位モデルとGoogle Workspace連携を拡張できるエントリー枠',
      target: 'コーディングエージェントは不要で、日常の調べ物やGoogleドキュメント連携を最安で底上げしたい人',
      badge: '🪙 月700円台〜最安級',
      deal: {
        hasDeal: false,
        badge: '⚠️ 年額約7,250円は公式記載なし（要確認）',
        annualDiscount: 'Google AI Plus ￥725 JPY/月（公式確定）。年払い約7,250円の原文記載は確認できず（要確認）',
        studentDiscount: 'なし（公式記載なし）',
        freeTier: '無料 ￥0 JPY/月（公式）',
        specialDeal: '無料版の2倍使用量上限・400GBストレージ・Flow 200クレジット（公式）',
        sourceUrl: 'https://gemini.google/subscriptions/',
        confirmedAt: '2026-11-16',
        verificationNote: '2026-11-16 日本地域公式ページ確認: ¥725/月確定。年額7,250円の記載なし=要確認'
      }
    },
    {
      id: 'chatgpt-go',
      name: 'ChatGPT Go (廉価ライト)',
      provider: 'OpenAI',
      priceUSD: 9,
      priceLabel: '約$8〜$10 / 月',
      priceNote: '日本円 約1,400〜1,500円前後',
      apiEquivalent: '💡 利用枠: Webチャット回数緩和枠',
      tokenRefresh: {
        type: 'auto',
        badge: '🔄 3時間毎にリセット',
        desc: '3時間ローリングでチャット回数が回復'
      },
      scoreBreakdown: { quota: 17, refresh: 8, agent: 18, price: 14, perk: 9 }, // 66点
      tier: 'chat-light',
      tierLabel: '💬 チャットのみ (廉価)',
      planGroup: 'chat-only',
      category: 'chat',
      hasAgent: false,
      agentBadge: '💬 チャット専用 (Codex枠なし)',
      agentDesc: 'Webチャットの回数制限緩和が目的のライトプラン（OpenAI Codex等の本格エージェントは非搭載）',
      models: 'GPT-5 軽量枠 / 標準チャットモデル',
      features: 'Plus ($20) の半額以下で無料版の回数制限を緩和し、日常のチャットや壁打ちを快適にする低価格プラン',
      target: 'コーディングエージェントは使わず、ChatGPTでの日常チャットだけを安く増やしたいライト層',
      badge: '💬 ChatGPT軽量版',
      deal: {
        hasDeal: false,
        badge: '💰 低価格ライト枠（金額は公式ページで要確認）',
        annualDiscount: 'Go月額の数値は2026-11-16公式pricingで動的描画のため原文確認できず（要確認）。FAQ: 個人Go/Plusはmonthly plans（確定）',
        studentDiscount: 'なし（教育向けはTeachers/EduプランでGo割引原文なし=要確認）',
        freeTier: '無料版ChatGPTあり（公式: Free is available to everyone）',
        specialDeal: 'Go＝Freeよりツール・アップロード・音声・メモリ増（公式）。半額以下帯の旧表現は要確認扱い',
        sourceUrl: 'https://openai.com/chatgpt/pricing/',
        confirmedAt: '2026-11-16',
        verificationNote: '2026-11-16 公式pricing確認: ページ・プラン名・FAQ（個人Goはmonthly plans）は確定。Go/Plus/Proの$数値はJS動的描画で原文取得不可=要確認'
      }
    },
    {
      id: 'perplexity-pro',
      name: 'Perplexity Pro',
      provider: 'Perplexity AI',
      priceUSD: 20,
      priceLabel: '$20 / 月',
      priceNote: '年払いは$200/年 (月$16.67)',
      apiEquivalent: '💡 利用枠: Pro検索300回/日 ＋ 月$5 APIクレジット',
      tokenRefresh: {
        type: 'auto',
        badge: '🔄 日次リセット＋定期回復',
        desc: 'Pro Search回数が定期リフレッシュ'
      },
      scoreBreakdown: { quota: 15, refresh: 8, agent: 19, price: 10, perkGeneral: 11, perkStudent: 14, perk: 11 }, // 一般63点 / 学生66点
      tier: 'chat-light',
      tierLabel: '💬 検索リサーチ ($20)',
      planGroup: 'chat-only',
      category: 'chat',
      hasAgent: false,
      agentBadge: '💬 Web検索特化 (Agentなし)',
      agentDesc: 'リアルタイムWeb検索・学術/技術リサーチ・ファクトチェック特化（自律コード編集機能なし）',
      models: 'GPT-5, Claude Sonnet 4.5, Sonar',
      features: '出典リンク明記の高速Web検索無制限、Deep Research、複数モデルの横断リサーチ',
      target: 'コーディング自体は別ツールで行い、技術ドキュメントや情報収集の速度を高めたい人',
      badge: '🔍 検索・調査特化',
      badgeGeneral: '🔍 検索・調査特化',
      badgeStudent: '🎓 学割 / 検索特化',
      deal: {
        hasDeal: false,
        badge: '💰 Pro $20/月・$200/年（2026-11-16公式FAQ原文確定）/ 学割は要確認',
        badgeGeneral: '💰 $20/month or $200/year（公式FAQ原文）/ 学割記載なし=要確認',
        badgeStudent: '⚠️ 学生向け割引は公式FAQに記載なし（要確認）',
        annualDiscount: 'Perplexity Pro is $20/month or $200/year（公式FAQ原文・2026-11-16 www.perplexity.ai/hub 確認）。月換算額・割引率の記載は公式にないため派生値は表示しない',
        studentDiscount: '学生向け割引の記載は公式FAQになし（2026-11-16 www.perplexity.ai/hub 確認）=要確認',
        freeTier: 'Perplexity is free to use for core search（公式FAQ原文・2026-11-16確認）。無料枠の回数条件の原文は未取得=要確認',
        specialDeal: 'ProでPro Search・Projects・file uploads・image generation・higher limitsが解放（公式FAQ原文）。www.perplexity.ai/pricingは404継続、hubページFAQが現行の一次出典',
        sourceUrl: 'https://www.perplexity.ai/hub',
        confirmedAt: '2026-11-16',
        verificationNote: '2026-11-16 www.perplexity.ai/hub FAQ原文確認: "Perplexity Pro is $20/month or $200/year"。月額/年額確定。学生割引の記載なし=要確認（pricingページ404は継続・hub FAQを一次出典とする）'
      }
    }
  ];

  // アプリケーション内部ステート
  let modelsData = [...DEFAULT_MODELS];
  let subscriptionPlans = [...SUBSCRIPTION_PLANS];
  let dealsData = null;
  let tierEvaluationData = null; // 独自コスパ評価データ（S/A/B/C/採点待ち）
  let campaignsData = { campaigns: [] };
  let applyNewUserCampaign = false;
  let exchangeRate = DEFAULT_RATE;
  let activeTierFilter = 'all'; // 'all' | 'flagship' | 'light'
  let activeSort = 'composite'; // 'value' | 'performance' | 'composite' | 'input' | 'output'
  let activeMode = 'sub'; // 'sub' (メイン) | 'api' (サブ)
  let activeSubTierFilter = 'agent-all'; // 'agent-all' | 'coding-agent' | 'native-agent' | 'entry' | 'deal' | 'chat-only'
  let activeSubSort = 'score'; // 'score' | 'price' | 'name'（既定は総合点順）
  let includeStudentDiscount = false; // デフォルトは一般・社会人基準（学割OFF）

  // API価格とセール情報の同期状態・取得日時を分離管理（要件2）
  let modelsSyncState = {
    synced: false,
    updatedCount: 0,
    syncTimeISO: null
  };

  let dealsSyncState = {
    synced: false,
    syncTimeISO: null
  };

  // テーマ設定キー
  const STORAGE_KEY_THEME = 'ai_budget_meter_theme';
  let currentTheme = 'auto'; // 'auto' | 'dark' | 'light'

  // DOM要素参照（DOMContentLoaded後のinitDomで初期化：要件5）
  let dom = {};

  function initDom() {
    dom = {
      themeToggleBtn: document.getElementById('theme-toggle-btn'),
      exchangeRateInput: document.getElementById('exchange-rate-input'),
      fetchLiveBtn: document.getElementById('fetch-live-btn'),
      dataStatusIndicator: document.getElementById('data-status-indicator'),
      sortSelect: document.getElementById('sort-select'),
      subSortSelect: document.getElementById('sub-sort-select'),
      studentToggle: document.getElementById('student-toggle'),
      campaignToggle: document.getElementById('campaign-toggle'),
      filterPanel: document.getElementById('filter-panel'),
      filterSummaryCurrent: document.getElementById('filter-summary-current'),
      filterTabs: document.querySelectorAll('.filter-tab:not(.sub-filter-tab)'),
      rankingTableBody: document.getElementById('ranking-table-body'),
      modeNavBtns: document.querySelectorAll('.mode-nav-btn'),
      sectionApi: document.getElementById('section-api'),
      sectionSub: document.getElementById('section-sub'),
      subFilterTabs: document.querySelectorAll('.sub-filter-tab'),
      subTableBody: document.getElementById('sub-table-body')
    };
  }

  /**
   * テーマの初期化と適用
   */
  function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY_THEME);
    } catch (_) {}

    if (saved === 'dark' || saved === 'light') {
      applyTheme(saved);
    } else {
      // 未設定（auto）時はOS設定に従って初期値を決定
      const osDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      applyTheme(osDark ? 'dark' : 'light');
    }

    // OSのカラースキーム変更を監視
    try {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      mql.addEventListener('change', (e) => {
        let savedNow = null;
        try {
          savedNow = localStorage.getItem(STORAGE_KEY_THEME);
        } catch (_) {}
        if (!savedNow) {
          applyTheme(e.matches ? 'dark' : 'light');
        }
      });
    } catch (_) {}
  }

  /**
   * テーマ適用とボタン表示同期
   */
  function applyTheme(theme) {
    currentTheme = theme;
    const isDark = theme === 'dark';

    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    if (document.body) {
      document.body.classList.toggle('dark-theme', isDark);
    }

    if (dom && dom.themeToggleBtn) {
      if (isDark) {
        dom.themeToggleBtn.textContent = '☀️ ライトテーマ';
        dom.themeToggleBtn.setAttribute('title', 'ライトモードに切り替えます');
      } else {
        dom.themeToggleBtn.textContent = '🌙 ダークテーマ';
        dom.themeToggleBtn.setAttribute('title', 'ダークモードに切り替えます');
      }
    }
  }

  /**
   * テーマの手動トグル切り替え
   */
  function toggleTheme() {
    const isCurrentlyDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const nextTheme = isCurrentlyDark ? 'light' : 'dark';
    try {
      localStorage.setItem(STORAGE_KEY_THEME, nextTheme);
    } catch (_) {}
    applyTheme(nextTheme);
  }

  /**
   * 通貨フォーマッタ（日本円）
   */
  function formatYen(num) {
    return '¥' + Math.round(num || 0).toLocaleString();
  }

  /**
   * 総合USD単価（入力3 : 出力1 加重平均）
   */
  function calculateCompositeUSD(model) {
    return (model.inputPrice * 3 + model.outputPrice * 1) / 4;
  }

  /**
   * APIモデルのコスパ指数（0〜100点）の算出
   */
  function calculateValueScore(model, yenPrice) {
    const perf = model.performanceScore || 80;
    const logCost = Math.log10(Math.max(yenPrice, 5)); // 最小5円ガード
    const raw = (perf * 2.8) / (logCost + 1.2);
    return Math.round(Math.min(99, Math.max(30, raw)));
  }

  /**
   * 定額プラン（サブスク）のコスパ指数（0〜100点）の算出
   * 5軸評価: ①実質API還元枠(25) + ②自動回復・即死耐性(10) + ③Agent×頭脳性能(35) + ④低価格性(15) + ⑤特典・割引(15)
   * ※ 一般モード（デフォルト）時は一般特典、学割ON時は学割特典スコアを採用
   */
  function calculateSubValueScore(plan) {
    if (!plan.scoreBreakdown) return 75;
    const b = plan.scoreBreakdown;
    const perkScore = includeStudentDiscount
      ? (b.perkStudent !== undefined ? b.perkStudent : (b.perk || 0))
      : (b.perkGeneral !== undefined ? b.perkGeneral : (b.perk || 0));
    const total = (b.quota || 0) + (b.refresh || 0) + (b.agent || 0) + (b.price || 0) + perkScore;
    return Math.min(99, Math.max(40, Math.round(total)));
  }

  /**
   * 月額課金（$20）換算トークン数・日本語文字数の算出
   */
  // 月額$20換算トークン数の算出（根拠のない日本語文字数換算は排除：要件7）
  function formatTokensAndChars(usdPer1M) {
    if (!usdPer1M || usdPer1M <= 0) return { tokenStr: '-' };
    const tokens = (20 / usdPer1M) * 1000000;

    let tokenStr = '';
    if (tokens >= 100000000) {
      tokenStr = `約 ${(tokens / 100000000).toFixed(1)} 億トークン`;
    } else if (tokens >= 10000) {
      tokenStr = `約 ${Math.round(tokens / 10000).toLocaleString()} 万トークン`;
    } else {
      tokenStr = `約 ${Math.round(tokens).toLocaleString()} トークン`;
    }

    return { tokenStr };
  }

  /**
   * セール・割引データのマスターへの適用・マージ
   */
  function applyDealsData() {
    if (!dealsData) return;

    // サブスクプランへのセール情報マージ
    if (dealsData.subscriptions) {
      subscriptionPlans = SUBSCRIPTION_PLANS.map(plan => {
        const deal = dealsData.subscriptions[plan.id];
        if (deal) {
          return {
            ...plan,
            deal: {
              ...(plan.deal || {}),
              ...deal
            }
          };
        }
        return plan;
      });
    }

    // API標準モデルへのセール・割引情報マージ
    if (dealsData.models) {
      modelsData = modelsData.map(m => {
        const mDeal = dealsData.models[m.id];
        if (mDeal) {
          return {
            ...m,
            deal: {
              ...(m.deal || {}),
              ...mDeal
            }
          };
        }
        return m;
      });
    }
  }

  /**
   * 設定およびキャッシュの読み込み
   */
  function loadSettingsAndCache() {
    try {
      const savedRate = localStorage.getItem(RATE_STORAGE_KEY);
      if (savedRate) {
        const r = Number(savedRate);
        if (!isNaN(r) && r >= 50 && r <= 500) exchangeRate = Math.round(r);
      }

      // モデル価格キャッシュの復元と検証（要件3）
      const cachedModelsStr = localStorage.getItem(MODELS_CACHE_STORAGE_KEY);
      const cachedModelsTime = localStorage.getItem(MODELS_SYNC_TIME_KEY);
      if (cachedModelsStr) {
        try {
          const parsed = JSON.parse(cachedModelsStr);
          const validated = validateModelList(parsed);
          if (validated && validated.length > 0) {
            modelsData = validated;
            modelsSyncState.synced = true;
            modelsSyncState.updatedCount = validated.length;
            modelsSyncState.syncTimeISO = cachedModelsTime || new Date().toISOString();
          } else {
            console.warn('キャッシュ内のモデルデータが無効なため、内蔵マスターデータを使用します');
            try {
              localStorage.removeItem(MODELS_CACHE_STORAGE_KEY);
              localStorage.removeItem(MODELS_SYNC_TIME_KEY);
            } catch (e) {}
          }
        } catch (e) {
          console.warn('モデルキャッシュのJSONパースに失敗しました:', e);
          try {
            localStorage.removeItem(MODELS_CACHE_STORAGE_KEY);
            localStorage.removeItem(MODELS_SYNC_TIME_KEY);
          } catch (err) {}
        }
      }

      // セール情報キャッシュの復元と検証（要件2・3）
      const cachedDealsStr = localStorage.getItem(DEALS_CACHE_STORAGE_KEY);
      const cachedDealsTime = localStorage.getItem(DEALS_SYNC_TIME_KEY);
      if (cachedDealsStr) {
        try {
          const parsed = JSON.parse(cachedDealsStr);
          if (validateDealsData(parsed)) {
            dealsData = parsed;
            dealsSyncState.synced = true;
            dealsSyncState.syncTimeISO = cachedDealsTime || new Date().toISOString();
            applyDealsData();
          } else {
            console.warn('キャッシュ内のセールデータが無効なため破棄します');
            try {
              localStorage.removeItem(DEALS_CACHE_STORAGE_KEY);
              localStorage.removeItem(DEALS_SYNC_TIME_KEY);
            } catch (e) {}
          }
        } catch (e) {
          console.warn('セールキャッシュのJSONパースに失敗しました:', e);
          try {
            localStorage.removeItem(DEALS_CACHE_STORAGE_KEY);
            localStorage.removeItem(DEALS_SYNC_TIME_KEY);
          } catch (err) {}
        }
      }
    } catch (err) {
      console.warn('localStorage読み込みエラー（プライベートブラウズまたは制限環境）:', err);
    }
  }

  /**
   * 為替レート保存
   */
  function saveExchangeRate(rate) {
    try {
      localStorage.setItem(RATE_STORAGE_KEY, String(rate));
    } catch (e) {
      console.warn('為替保存失敗:', e);
    }
  }

  /**
   * 生データおよび最新セール情報のフェッチ（OpenRouter公開API / models_live.json / deals_live.json）
   */
  /**
   * リクエスト開始からJSONパース完了まで8秒タイムアウトを維持するヘルパー（要件2）
   * （ヘッダー取得後に本文ストリームが停止する遅延・ハングも検知・遮断）
   * ※ 8秒は接続から本文受信・JSONパース完了までのリクエストごとの制限時間
   */
  async function fetchJsonWithTimeout(resource, options = {}) {
    const { timeout = FETCH_TIMEOUT_MS } = options;
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(resource, {
        ...options,
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP status: ${response.status}`);
      }
      const json = await response.json(); // response.json() 完了までタイマーを維持
      return json;
    } finally {
      clearTimeout(timerId);
    }
  }

  /**
   * API価格データおよびセール情報の同期（要件1〜6：厳格パース・非丸め・ID検証・マージ・タイムアウト・finally復旧）
   */
  async function fetchLiveModels() {
    dom.fetchLiveBtn.disabled = true;
    dom.fetchLiveBtn.textContent = '⏳ データ同期中...';
    dom.dataStatusIndicator.textContent = '🔄 各社標準モデル単価 & 特典データを照合中...';

    let updatedCount = 0;
    let syncSource = 'none';
    let dealsSuccess = false;
    const nowISO = new Date().toISOString();

    try {
      // 1. OpenRouter公開API直接fetch（CORS対応・本文完了までタイムアウト維持）
      try {
        const json = await fetchJsonWithTimeout('https://openrouter.ai/api/v1/models', { mode: 'cors' });
        const liveList = Array.isArray(json.data) ? json.data : [];
        const liveMap = {};
        liveList.forEach(m => {
          if (!m || typeof m !== 'object' || Array.isArray(m)) return;
          // 要件4: id が文字列か確認してから正規化（不正な1レコードで処理を止めない）
          if (typeof m.id !== 'string') return;
          const mid = m.id.trim().toLowerCase();
          if (!mid) return;
          const p = m.pricing;
          if (!p || typeof p !== 'object' || Array.isArray(p)) return;

          // 要件1: 型と空欄を厳格検証（数値および空でない数値文字列のみ。null/空文字/booleanは除外）
          const parsedPrompt = parseStrictPrice(p.prompt, false); // 入力価格: > 0
          const parsedComp = parseStrictPrice(p.completion, true); // 出力価格: >= 0（0, "0" は許容、nullや空文字は拒否）

          if (parsedPrompt !== null && parsedComp !== null) {
            const promptPer1M = parsedPrompt * 1000000;
            const compPer1M = parsedComp * 1000000;
            if (promptPer1M > 0 && isFinite(promptPer1M) && isFinite(compPer1M)) {
              // 要件3: 丸めずに生数値を格納（表示時のみ丸める）
              liveMap[mid] = { prompt: promptPer1M, comp: compPer1M };
            }
          }
        });

        // 既存の有効モデルデータに対して、有効価格が取れたもののみ更新
        let matchCount = 0;
        const nextModels = modelsData.map(dm => {
          const live = liveMap[dm.id.toLowerCase()];
          if (live && live.prompt > 0 && live.comp >= 0) {
            matchCount++;
            return {
              ...dm,
              inputPrice: live.prompt,   // 生価格をそのまま保持（要件3）
              outputPrice: live.comp     // 生価格をそのまま保持（要件3）
            };
          }
          return dm; // 取得できなかったモデルは既存価格を維持（要件1）
        });

        // 有効価格が1件以上更新された場合のみコミット（0件一致では成功にしない：要件1）
        if (matchCount > 0) {
          modelsData = nextModels;
          updatedCount = matchCount;
          syncSource = 'openrouter';
          modelsSyncState = {
            synced: true,
            source: 'OpenRouter公開API',
            updatedCount: updatedCount,
            syncTimeISO: nowISO
          };
          try {
            localStorage.setItem(MODELS_CACHE_STORAGE_KEY, JSON.stringify(modelsData));
            localStorage.setItem(MODELS_SYNC_TIME_KEY, nowISO);
          } catch (e) {
            console.warn('localStorageへのモデルキャッシュ保存に失敗しました:', e);
          }
        }
      } catch (e) {
        console.warn('OpenRouter直接取得エラー、models_live.json を試行します:', e);
      }

      // 2. 外部APIで0件だった場合、同梱の models_live.json を試行
      // 要件5: 一覧全体を置き換えずに、対象IDの有効価格だけを既存データへマージ
      if (updatedCount === 0) {
        try {
          const localJson = await fetchJsonWithTimeout('models_live.json');
          if (Array.isArray(localJson)) {
            const localMap = {};
            localJson.forEach(m => {
              if (!m || typeof m !== 'object' || Array.isArray(m)) return;
              if (typeof m.id !== 'string') return;
              const mid = m.id.trim().toLowerCase();
              if (!mid) return;
              const inp = parseStrictPrice(m.inputPrice, false);
              const out = parseStrictPrice(m.outputPrice, true);
              if (inp !== null && out !== null) {
                localMap[mid] = { prompt: inp, comp: out };
              }
            });

            let localMatchCount = 0;
            const nextLocalModels = modelsData.map(dm => {
              const live = localMap[dm.id.toLowerCase()];
              if (live && live.prompt > 0 && live.comp >= 0) {
                localMatchCount++;
                return {
                  ...dm,
                  inputPrice: live.prompt,
                  outputPrice: live.comp
                };
              }
              return dm; // 対象外または無効なものは既存を維持
            });

            if (localMatchCount > 0) {
              modelsData = nextLocalModels;
              updatedCount = localMatchCount;
              syncSource = 'models_live.json';
              modelsSyncState = {
                synced: true,
                source: '同梱静的ファイル (models_live.json)',
                updatedCount: updatedCount,
                syncTimeISO: nowISO
              };
              try {
                localStorage.setItem(MODELS_CACHE_STORAGE_KEY, JSON.stringify(modelsData));
                localStorage.setItem(MODELS_SYNC_TIME_KEY, nowISO);
              } catch (e) {
                console.warn('localStorageへのモデルキャッシュ保存に失敗しました:', e);
              }
            }
          }
        } catch (err) {
          console.warn('models_live.json読み込みエラー:', err);
        }
      }

      // 3. 特典・セール情報（deals_live.json）の取得（要件2・6：本文完了までタイムアウト維持 & フィールド型検証）
      try {
        const dealsJson = await fetchJsonWithTimeout('deals_live.json');
        if (validateDealsData(dealsJson)) {
          dealsData = dealsJson;
          dealsSuccess = true;
          dealsSyncState = {
            synced: true,
            syncTimeISO: nowISO
          };
          applyDealsData();
          try {
            localStorage.setItem(DEALS_CACHE_STORAGE_KEY, JSON.stringify(dealsJson));
            localStorage.setItem(DEALS_SYNC_TIME_KEY, nowISO);
          } catch (e) {
            console.warn('localStorageへのセール情報キャッシュ保存に失敗しました:', e);
          }
        } else {
          console.warn('deals_live.json のスキーマ検証に失敗しました');
        }
      } catch (err) {
        console.warn('deals_live.json読み込みエラー:', err);
      }

      // 結果案内（要件6：保持したデータの実態に合わせて表示）
      if (updatedCount > 0 && dealsSuccess) {
        alert(`API単価（${updatedCount}件：${syncSource}）および特典データの同期に成功しました。`);
      } else if (updatedCount > 0) {
        alert(`API単価（${updatedCount}件：${syncSource}）の同期に成功しました。（特典データは既存定義を維持）`);
      } else if (dealsSuccess) {
        alert(`特典データの同期に成功しました。（API単価は現在の有効データを維持）`);
      } else {
        alert('ネットからの同期ができなかったため、現在の有効データをそのまま維持します。');
      }

    } catch (unexpectedErr) {
      console.error('同期処理中に予期せぬエラーが発生しました:', unexpectedErr);
      alert('同期処理中にエラーが発生したため、現在の有効データを維持します。');
    } finally {
      // 要件4: finally で確実にボタンと表示を復旧
      dom.fetchLiveBtn.disabled = false;
      dom.fetchLiveBtn.textContent = '🔄 ネットからAPI単価を更新';
      render();
      renderSubscriptions();
    }
  }

    /**
   * ランキング画面描画
   */
  function render() {
    // コントロール同期
    dom.exchangeRateInput.value = exchangeRate;

    // ステータスインジケータ（要件4, 5：取得元・日時・更新件数・未更新分の明示）
    const statusParts = [];
    if (modelsSyncState.synced && modelsSyncState.updatedCount > 0) {
      const timeStr = modelsSyncState.syncTimeISO ? modelsSyncState.syncTimeISO.slice(0, 19).replace('T', ' ') : '';
      const totalCount = DEFAULT_MODELS.length;
      const unupdated = totalCount - modelsSyncState.updatedCount;
      const unupdatedText = unupdated > 0 ? ` (未更新 ${unupdated}件)` : '';
      statusParts.push(`API価格: ${modelsSyncState.source} (${modelsSyncState.updatedCount}/${totalCount}件更新${unupdatedText}, 同期日時: ${timeStr} UTC)`);
    } else {
      statusParts.push('API価格: 未確認の参考初期値（OpenRouter未同期）');
    }

    if (dealsSyncState.synced) {
      const dTimeStr = dealsSyncState.syncTimeISO ? dealsSyncState.syncTimeISO.slice(0, 19).replace('T', ' ') : '';
      statusParts.push(`特典情報: 同期済 (${dTimeStr} UTC)`);
    }

    if (modelsSyncState.synced || dealsSyncState.synced) {
      dom.dataStatusIndicator.textContent = `🟢 ${statusParts.join(' / ')}`;
      dom.dataStatusIndicator.className = 'status-indicator is-live';
    } else {
      dom.dataStatusIndicator.textContent = '📦 各社標準モデル データ表示中（未確認の参考初期値・API未同期）';
      dom.dataStatusIndicator.className = 'status-indicator';
    }

    // カテゴリタブ同期
    dom.filterTabs.forEach(tab => {
      const t = tab.getAttribute('data-tier');
      if (t === activeTierFilter) {
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
      } else {
        tab.classList.remove('active');
        tab.setAttribute('aria-selected', 'false');
      }
    });

    // フィルタリング（区分: flagship / light / all）
    let filtered = modelsData.filter(m => {
      if (activeTierFilter === 'all') return true;
      return m.tier === activeTierFilter;
    });

    // 複合単価の算出（入力75%・出力25%と仮定：要件7）
    filtered.forEach(m => {
      m.compositeUSD = calculateCompositeUSD(m);
    });

    // ソート処理（客観的単価順のみに限定：要件1）
    filtered.sort((a, b) => {
      if (activeSort === 'input') {
        return a.inputPrice - b.inputPrice; // 入力単価順
      } else if (activeSort === 'output') {
        return a.outputPrice - b.outputPrice; // 出力単価順
      } else {
        return a.compositeUSD - b.compositeUSD; // 複合単価順（デフォルト）
      }
    });

    // テーブル描画（性能スコア・コスパ指数・順位を非表示化：要件1）
    dom.rankingTableBody.textContent = '';
    const frag = document.createDocumentFragment();

    filtered.forEach(m => {
      const tr = document.createElement('tr');

      // 1. モデル名 / プロバイダ
      const tdName = document.createElement('td');
      const nameWrapper = document.createElement('div');
      nameWrapper.className = 'model-name-wrapper';

      const strongName = document.createElement('strong');
      strongName.className = 'model-name';
      strongName.textContent = m.name;
      nameWrapper.appendChild(strongName);
      nameWrapper.appendChild(document.createTextNode(' '));

      const spanProvider = document.createElement('span');
      spanProvider.className = 'provider-tag';
      spanProvider.textContent = m.provider;
      nameWrapper.appendChild(spanProvider);

      tdName.appendChild(nameWrapper);
      tr.appendChild(tdName);

      // 2. 区分 (Flagship / Light)
      const tdTier = document.createElement('td');
      const tierBadge = document.createElement('span');
      tierBadge.className = 'tier-badge ' + (m.tier === 'flagship' ? 'tier-flagship' : 'tier-light');
      tierBadge.textContent = TIER_NAMES[m.tier] || m.tier;
      tdTier.appendChild(tierBadge);
      tr.appendChild(tdTier);

      // 3. 概要・仕様
      const tdTag = document.createElement('td');
      tdTag.textContent = m.tag || '-';
      tr.appendChild(tdTag);

      // 4. 入力 / 出力単価 (1Mトークン)
      const tdPrice = document.createElement('td');
      tdPrice.className = 'price-cell';

      const inDiv = document.createElement('div');
      inDiv.className = 'price-row in-row';
      const inLabel = document.createElement('span');
      inLabel.className = 'price-lbl';
      inLabel.textContent = '入力: ';
      const inMain = document.createElement('strong');
      const inYen = Math.round(m.inputPrice * exchangeRate);
      inMain.textContent = formatYen(inYen);
      const inUsd = document.createElement('span');
      inUsd.className = 'usd-sub';
      inUsd.textContent = ` ($${m.inputPrice.toFixed(m.inputPrice < 0.1 ? 3 : 2)})`;
      inDiv.appendChild(inLabel);
      inDiv.appendChild(inMain);
      inDiv.appendChild(inUsd);

      const outDiv = document.createElement('div');
      outDiv.className = 'price-row out-row';
      const outLabel = document.createElement('span');
      outLabel.className = 'price-lbl';
      outLabel.textContent = '出力: ';
      const outMain = document.createElement('strong');
      const outYen = Math.round(m.outputPrice * exchangeRate);
      outMain.textContent = formatYen(outYen);
      const outUsd = document.createElement('span');
      outUsd.className = 'usd-sub';
      outUsd.textContent = ` ($${m.outputPrice.toFixed(2)})`;
      outDiv.appendChild(outLabel);
      outDiv.appendChild(outMain);
      outDiv.appendChild(outUsd);

      tdPrice.appendChild(inDiv);
      tdPrice.appendChild(outDiv);
      tr.appendChild(tdPrice);

      // 5. 複合単価 (1M・入力75%出力25%仮定)
      const tdComp = document.createElement('td');
      tdComp.className = 'price-cell composite-cell';
      const compDiv = document.createElement('div');
      compDiv.className = 'price-row comp-row';
      const compMain = document.createElement('strong');
      const compYen = Math.round(m.compositeUSD * exchangeRate);
      compMain.textContent = formatYen(compYen);
      const compUsd = document.createElement('span');
      compUsd.className = 'usd-sub';
      compUsd.textContent = ` ($${m.compositeUSD.toFixed(3)})`;
      compDiv.appendChild(compMain);
      compDiv.appendChild(compUsd);
      tdComp.appendChild(compDiv);
      tr.appendChild(tdComp);

      // 6. 月額$20換算 トークン量
      const tdSub = document.createElement('td');
      tdSub.className = 'sub-token-cell';
      const subInfo = formatTokensAndChars(m.compositeUSD);
      const spanToken = document.createElement('div');
      spanToken.className = 'token-count';
      spanToken.textContent = subInfo.tokenStr;
      tdSub.appendChild(spanToken);
      tr.appendChild(tdSub);

      // 7. 価格ステータス（取得元 / 未確認参考値）
      const tdStatus = document.createElement('td');
      const statusBadge = document.createElement('span');
      if (modelsSyncState.synced) {
        statusBadge.className = 'status-pill live-pill';
        statusBadge.textContent = '同期済 (OpenRouter)';
      } else {
        statusBadge.className = 'status-pill ref-pill';
        statusBadge.textContent = '未確認の参考初期値';
      }
      tdStatus.appendChild(statusBadge);
      tr.appendChild(tdStatus);

      frag.appendChild(tr);
    });

    dom.rankingTableBody.appendChild(frag);
  }
  /**
   * 総合点からランクを返す。境界は subscriptions_tier.json の rank_boundaries に準拠。
   * S: 90点以上 / A: 75点以上90点未満 / B: 60点以上75点未満 / C: 60点未満
   */
  function rankFromScore(score) {
    if (typeof score !== 'number' || !isFinite(score)) return '—';
    if (score >= 90) return 'S';
    if (score >= 75) return 'A';
    if (score >= 60) return 'B';
    return 'C';
  }

  /**
   * 為替レートとキャンペーン割引を評価データへ反映する。
   * - price_jpy が JSON 固定値でない場合は price_usd × exchangeRate で再計算
   * - 支払負担スコア（payment）を 90日コストから再計算し、総合点・ランクも更新
   * 採点の「配点・境界」は変更せず、レート入力と割引に対する再計算のみを行う。
   *
   * @param {object} evalInfo 評価データ
   * @param {number|null} discountedCost90d キャンペーン適用後の90日費用（円）。未適用なら null
   */
  function applyExchangeRateToEval(evalInfo, discountedCost90d) {
    if (!evalInfo) return;
    const usd = (typeof evalInfo.price_usd === 'number') ? evalInfo.price_usd : null;
    const fixedJpy = (typeof evalInfo.price_jpy === 'number') ? evalInfo.price_jpy : null;

    // 90日コスト（円）を決定：固定円価格 > USD×レート
    let cost90d = null;
    if (fixedJpy !== null) {
      cost90d = Math.round(fixedJpy * 3);
    } else if (usd !== null) {
      cost90d = Math.round(usd * exchangeRate * 3);
    }
    if (cost90d === null) return;

    // キャンペーン適用時は割引後の90日費用で支払負担点を計算する
    const baseCost90d = cost90d;
    if (typeof discountedCost90d === 'number' && discountedCost90d >= 0) {
      cost90d = discountedCost90d;
    }

    evalInfo.cost_90d_yen = cost90d;
    evalInfo.base_cost_90d_yen = baseCost90d;

    // 支払負担スコアの再計算（配点は JSON の max を使用）
    // 式: score = max * max(0, 1 - cost90d / 15000)
    //   90日コスト 0円 → 満点、15,000円以上 → 0点の線形逓減。
    const payment = evalInfo.scores && evalInfo.scores.payment;
    if (payment && typeof payment.max === 'number') {
      const max = payment.max;
      const COST_CAP = 15000;
      let score = max * Math.max(0, 1 - cost90d / COST_CAP);
      score = Math.max(0, Math.min(max, score));
      payment.score = Math.round(score * 100) / 100;
      payment.cost_90d_yen = cost90d;
    }

    // 総合点を4軸合計から再計算（配点・境界は不変）
    if (evalInfo.scores && !evalInfo.is_pending) {
      let total = 0;
      let hasAll = true;
      ['payment', 'quota', 'fit', 'continuity'].forEach(k => {
        const s = evalInfo.scores[k];
        if (s && typeof s.score === 'number') total += s.score;
        else if (s) hasAll = false;
      });
      if (hasAll) {
        evalInfo.total_score = Math.round(total * 100) / 100;
        // ランク境界（S:90+ / A:75+ / B:60+ / C:60未満）は JSON の定義どおり不変
        evalInfo.rank = rankFromScore(evalInfo.total_score);
      }
    }
  }

  /** 文末の句点・空白を除去する（後続で「。」を付け足す際に「。。」とならないようにする） */
  function trimJaEnd(text) {
    return String(text == null ? '' : text).replace(/[。．.\s]+$/, '');
  }

  // ステージ31: deal参考情報の解決と1行ノート生成を共通化（ax1詳細とchat-only価格セルで共用・文言はステージ30と同一）
  function resolveDealInfo(planId) {
    if (dealsData && dealsData.subscriptions && dealsData.subscriptions[planId]) {
      return dealsData.subscriptions[planId];
    }
    const master = subscriptionPlans.find(x => x.id === planId) || SUBSCRIPTION_PLANS.find(x => x.id === planId);
    return (master && master.deal) || null;
  }
  function buildDealNote(dealInfo) {
    if (!dealInfo) return '';
    const src = (typeof dealInfo.sourceUrl === 'string' && dealInfo.sourceUrl.trim()) ? `（出典: ${dealInfo.sourceUrl}）` : '';
    const cfm = (typeof dealInfo.confirmedAt === 'string' && dealInfo.confirmedAt.trim()) ? ` 確認日: ${dealInfo.confirmedAt}` : '';
    const vnote = (typeof dealInfo.verificationNote === 'string' && dealInfo.verificationNote.trim()) ? dealInfo.verificationNote : '';
    if (vnote || src || cfm) return `【参考情報】${vnote}${src}${cfm}`;
    return '';
  }

  /**
   * 日本時間（Asia/Tokyo）の今日を YYYY-MM-DD で返す。
   * テスト用に window.__TODAY__ が YYYY-MM-DD 形式で注入されていればそれを優先する。
   * 通常時は window.__TODAY__ は未定義なので端末時刻から日本時間を算出する。
   */
  function getTodayJst() {
    const injected = (typeof window !== 'undefined') ? window.__TODAY__ : undefined;
    if (typeof injected === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(injected)) {
      return injected;
    }
    // 端末のタイムゾーンに依存せず、日本時間の日付を得る
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const get = (t) => (parts.find(p => p.type === t) || {}).value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  /**
   * 新規契約キャンペーンの適用可否を判定する。
   * 適用条件（すべて満たす場合のみ applied）:
   *   1. verification_status === 'verified'
   *   2. start_date と end_date が両方 YYYY-MM-DD で明示されている（期間未指定は適用しない）
   *   3. 日本時間の今日が start_date <= 今日 <= end_date（両端を含む）
   * 期間が終了している場合は expired、開始前は not_started、期間不明は unknown。
   */
  function resolveCampaignInfo(plan, evalInfo) {
    const list = (campaignsData && Array.isArray(campaignsData.campaigns)) ? campaignsData.campaigns : [];
    const camp = list.find(c => c && c.target_plan_id === plan.id);
    if (!camp) return { status: 'none', applied: null };

    const status = camp.verification_status;
    const start = camp.start_date;
    const end = camp.end_date;

    // 期間未指定は適用しない（推測適用の禁止）
    if (!start || !end) {
      return { status: 'unknown', applied: null, reason: '期間未指定のため不適用' };
    }

    // 日付形式が不正なら適用しない
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
      return { status: 'unknown', applied: null, reason: '期間の日付形式が不正' };
    }

    // YYYY-MM-DD は辞書順比較で日付比較になる（両端を含む）
    const today = getTodayJst();
    if (today < start) return { status: 'not_started', applied: null, reason: '開始前' };
    if (today > end) return { status: 'expired', applied: null, reason: '終了後' };

    // 期間は有効。ただし verified 以外は適用しない。
    if (status !== 'verified') {
      return { status: 'unverified', applied: null, reason: '未確認のため不適用' };
    }

    // 新規契約スイッチが OFF なら適用しない
    if (!applyNewUserCampaign) {
      return { status: 'available', applied: null, reason: '新規契約スイッチOFF' };
    }

    // 適用計算（90日 = 3か月）
    const benefit = camp.benefit || {};
    const usd = (typeof evalInfo.price_usd === 'number') ? evalInfo.price_usd : null;
    const fixedJpy = (typeof evalInfo.price_jpy === 'number') ? evalInfo.price_jpy : null;
    const monthlyJpy = (fixedJpy !== null) ? fixedJpy : (usd !== null ? Math.round(usd * exchangeRate) : null);
    if (monthlyJpy === null) return { status: 'none', applied: null };

    const discountMonths = (typeof benefit.discount_months === 'number') ? benefit.discount_months : 0;
    const discountJpy = (typeof benefit.discount_price_jpy === 'number')
      ? benefit.discount_price_jpy
      : (typeof benefit.discount_price_usd === 'number' ? Math.round(benefit.discount_price_usd * exchangeRate) : null);

    let cost90d = monthlyJpy * 3;
    if (discountMonths > 0 && discountJpy !== null) {
      const discounted = Math.min(discountMonths, 3);
      cost90d = Math.round(discountJpy * discounted + monthlyJpy * (3 - discounted));
    }
    const savingsYen = Math.max(0, monthlyJpy * 3 - cost90d);

    return {
      status: 'applied',
      applied: {
        title: camp.title || 'キャンペーン',
        cost90d,
        savingsYen,
        campaignId: camp.campaign_id,
      },
    };
  }

  /**
   * 月額定額サブスクプラン表の描画（DOM API構築・確認状態区分対応）
   */
  function renderSubscriptions() {
    // 判定関数（公式ドキュメントより情報取得・検証中プランか否か）
    const isVerifiedPlan = (plan) => plan.id === 'github-copilot' || Boolean(plan.isVerificationTarget);

    // フィルタリング
    let filtered = subscriptionPlans.filter(plan => planMatchesSubTier(plan, activeSubTierFilter));


    // 確認状態によるグルーピング（要件1, 2: おすすめ順位ではなく、確認状態による区分）
    const verifiedList = filtered.filter(p => isVerifiedPlan(p));
    const unverifiedList = filtered.filter(p => !isVerifiedPlan(p));

    // グループ内ソート（確認済みプランとは順位を混ぜない：要件2, 3）
    // score: 総合点降順 / price: 月額昇順 / name: サービス名昇順
    const sortList = (list) => {
      return list.sort((a, b) => {
        if (activeSubSort === 'name') {
          return (a.name || '').localeCompare(b.name || '', 'ja');
        }
        if (activeSubSort === 'price') {
          const pA = typeof a.priceUSD === 'number' ? a.priceUSD : 9999;
          const pB = typeof b.priceUSD === 'number' ? b.priceUSD : 9999;
          return pA - pB;
        }
        // 既定は総合点順（未評価は末尾）
        const sA = (a.evalInfo && typeof a.evalInfo.total_score === 'number') ? a.evalInfo.total_score : -1;
        const sB = (b.evalInfo && typeof b.evalInfo.total_score === 'number') ? b.evalInfo.total_score : -1;
        return sB - sA;
      });
    };

    sortList(unverifiedList);

    // サブスクカテゴリタブ同期（絞り込みサマリーの現在値表示も同時に更新）
    let activeTabLabel = 'すべて';
    dom.subFilterTabs.forEach(tab => {
      const st = tab.getAttribute('data-subtier') || tab.getAttribute('data-sub-tier');
      updateSubTabCount(tab, st);
      if (st === activeSubTierFilter) {
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        activeTabLabel = (tab.textContent || '').replace(/\s*\(\d+\)\s*$/, '').trim() || 'すべて';
      } else {
        tab.classList.remove('active');
        tab.setAttribute('aria-selected', 'false');
      }
    });
    if (dom.filterSummaryCurrent) {
      dom.filterSummaryCurrent.textContent = activeTabLabel;
    }

    dom.subTableBody.textContent = '';
    const frag = document.createDocumentFragment();

    /**
     * プラン行のDOM生成
     */
    /**
     * プラン行のDOM生成（初期表示：情報整理・重複削減版）
     * 採点・点数・ランク・キャンペーン計算は変更しない。
     * 各プランはサービス名・色付きランク・順位・総合点・月額概算・確認日を1回だけ表示。
     * 4軸・根拠・長い機能説明・補足は「詳細・採点内訳」開閉パネルへ集約。
     * 評価保留は「評価保留」+理由要約1行を常時表示、不足項目一覧は開閉パネル内へ。
     */
    function resolveTierRankBadge(evalInfo) {
      // 評価保留は常に「—」
      if (!evalInfo || evalInfo.is_pending) {
        return { cssClass: 'rank-hero-pending', letter: '—', sublabel: '評価保留', ariaLabel: '評価保留' };
      }
      // rank が明示されていればそれを優先。無ければ total_score から境界判定する。
      let rank = evalInfo.rank;
      if (rank !== 'S' && rank !== 'A' && rank !== 'B' && rank !== 'C') {
        rank = rankFromScore(evalInfo.total_score);
      }
      if (rank === 'S') return { cssClass: 'rank-hero-s', letter: 'S', sublabel: 'ランク S', ariaLabel: 'ランクS' };
      if (rank === 'A') return { cssClass: 'rank-hero-a', letter: 'A', sublabel: 'ランク A', ariaLabel: 'ランクA' };
      if (rank === 'B') return { cssClass: 'rank-hero-b', letter: 'B', sublabel: 'ランク B', ariaLabel: 'ランクB' };
      if (rank === 'C') return { cssClass: 'rank-hero-c', letter: 'C', sublabel: 'ランク C', ariaLabel: 'ランクC' };
      return { cssClass: 'rank-hero-pending', letter: '—', sublabel: '評価保留', ariaLabel: '評価保留' };
    }

    function buildPlanRow(item, isRankedGroup) {
      const { plan, evalInfo } = item;
      const tr = document.createElement('tr');

      // ---------- 1. サービス名 / 提供元 / 区分 / 確認状態 / ランク ----------
      const tdName = document.createElement('td');
      tdName.className = 'sub-name-cell';
      const nameWrapper = document.createElement('div');
      nameWrapper.className = 'sub-name-wrapper';

      const strongName = document.createElement('strong');
      strongName.className = 'sub-plan-name';
      strongName.textContent = plan.name;
      nameWrapper.appendChild(strongName);
      // textContent・コピー・読み上げでサービス名と提供元が直結しないよう半角スペースで区切る
      nameWrapper.appendChild(document.createTextNode(' '));

      // 提供元はサービス名と別行に固定（モバイル項目4: 折返し任せにせず独立行ブロック化）
      const providerRow = document.createElement('div');
      providerRow.className = 'sub-provider-row';
      const spanProvider = document.createElement('span');
      spanProvider.className = 'sub-provider-tag';
      spanProvider.textContent = `提供: ${plan.provider}`;
      providerRow.appendChild(spanProvider);

      // 公式・確認元リンクの設置（全プランでワンクリック確認を可能にする）
      const officialUrl = (evalInfo && evalInfo.source_urls && evalInfo.source_urls[0]) || plan.sourceUrl || null;
      if (officialUrl) {
        providerRow.appendChild(document.createTextNode(' '));
        const aOfficial = document.createElement('a');
        aOfficial.className = 'sub-official-link';
        aOfficial.href = officialUrl;
        aOfficial.target = '_blank';
        aOfficial.rel = 'noopener noreferrer';
        aOfficial.textContent = '公式情報 ↗';
        aOfficial.setAttribute('aria-label', (plan.name || '') + ' の公式・確認元ページを新しいタブで開く');
        providerRow.appendChild(aOfficial);
      }

      nameWrapper.appendChild(providerRow);
      nameWrapper.appendChild(document.createTextNode(' '));

      const tierBadge = document.createElement('span');
      const tierClass = plan.planGroup === 'coding-agent'
        ? 'tier-entry'
        : (plan.planGroup === 'native-agent' ? 'tier-standard' : 'tier-light');
      tierBadge.className = 'tier-badge ' + tierClass;
      tierBadge.textContent = plan.tierLabel;
      nameWrapper.appendChild(tierBadge);
      nameWrapper.appendChild(document.createTextNode(' '));

      const verificationTag = document.createElement('span');
      if (evalInfo && !evalInfo.is_pending) {
        verificationTag.className = 'verification-badge badge-verified';
        verificationTag.textContent = 'ランク確定';
      } else if (evalInfo) {
        verificationTag.className = 'verification-badge badge-pending';
        verificationTag.textContent = '評価保留（確認待ち）';
      } else {
        verificationTag.className = 'verification-badge badge-unverified';
        verificationTag.textContent = '未確認の参考情報';
      }
      nameWrapper.appendChild(verificationTag);
      nameWrapper.appendChild(document.createTextNode(' '));

      // ランク表示：大きな色付きS/A/B/C + 順位 + 総合点（1回ずつ）
      if (evalInfo) {
        const rankWrap = document.createElement('div');
        rankWrap.className = 'sub-rank-wrap tier-rank-hero-box ' + resolveTierRankBadge(evalInfo).cssClass;

        const heroBadgeData = resolveTierRankBadge(evalInfo);
        const heroLetter = document.createElement('span');
        heroLetter.className = 'sub-hero-letter tier-hero-letter ' + heroBadgeData.cssClass;
        heroLetter.textContent = heroBadgeData.letter;
        heroLetter.setAttribute('aria-label', heroBadgeData.ariaLabel);
        rankWrap.appendChild(heroLetter);
        rankWrap.appendChild(document.createTextNode(' '));

        // 評価保留は「評価保留」を1回だけ表示する（sublabel との二重表示を解消）
        const rankMeta = document.createElement('span');
        rankMeta.className = 'sub-rank-meta';
        if (evalInfo.rank === '—') {
          rankMeta.textContent = '評価保留';
          rankWrap.classList.add('is-pending');
        } else {
          const rankPart = item.rankDisplay ? item.rankDisplay : '';
          const scorePart = evalInfo.total_score !== null ? ` ${evalInfo.total_score.toFixed(2)}点` : '';
          rankMeta.textContent = `${rankPart}${scorePart}`.trim();
        }
        rankWrap.appendChild(rankMeta);

        // ランク確定時は左の大きなランク文字と重複するため、右端の「ランク A」表記は出さない。
        nameWrapper.appendChild(rankWrap);
      }

      tdName.appendChild(nameWrapper);
      tr.appendChild(tdName);

      // ---------- 2. 月額料金・キャンペーン・確認日・採点内訳トグル ----------
      const tdPriceDeal = document.createElement('td');
      tdPriceDeal.className = 'sub-deal-cell';

      const priceBox = document.createElement('div');
      priceBox.className = 'sub-price-box';

      const mainPrice = document.createElement('span');
      mainPrice.className = 'sub-main-price';
      // JSON で価格が確定していない（price_usd / price_jpy が無い）場合は「要確認」と表示する。
      const jsonUsdKnown = evalInfo && typeof evalInfo.price_usd === 'number';
      const jsonJpyKnown = evalInfo && typeof evalInfo.price_jpy === 'number';
      if (plan.priceUSD === 0) {
        mainPrice.textContent = plan.priceLabel;
      } else if (evalInfo && !jsonUsdKnown && !jsonJpyKnown) {
        mainPrice.textContent = '月額: 要確認';
        mainPrice.classList.add('price-unconfirmed');
      } else if (evalInfo && evalInfo.scores && evalInfo.scores.payment && evalInfo.scores.payment.score !== null) {
        if (jsonJpyKnown) {
          mainPrice.textContent = `月 ${formatYen(evalInfo.price_jpy)} JPY ※公式表示価格(税の扱いは各社の表示による)`;
        } else {
          const yenPrice = Math.round(evalInfo.price_usd * exchangeRate);
          mainPrice.textContent = `月約 ${formatYen(yenPrice)}`;
        }
      } else if (evalInfo) {
        mainPrice.textContent = '月額: 要確認';
        mainPrice.classList.add('price-unconfirmed');
      } else {
        mainPrice.textContent = plan.priceLabel;
      }
      priceBox.appendChild(mainPrice);

      // 評価保留プランの場合、理由要約バッジを表示して「取得失敗」ではなく理由を直感的に伝える
      if (evalInfo && evalInfo.is_pending) {
        priceBox.appendChild(document.createTextNode(' '));
        const pendingBadge = document.createElement('span');
        pendingBadge.className = 'tier-pending-summary-badge';
        if (evalInfo.plan_id === 'kimi-coding') {
          pendingBadge.textContent = '※公式国際料金未公表（中国版99元/月のみ確認）';
        } else if (evalInfo.plan_id === 'cursor-pro') {
          pendingBadge.textContent = '※新規受付停止（既存契約者専用・新体系へ移行済）';
        } else {
          pendingBadge.textContent = '※一部情報未確認のため保留';
        }
        priceBox.appendChild(pendingBadge);
      }

      // チャットのみ・ライト枠は公式確認の対象外。価格・点数は変えず、参考値であることだけ明示する
      if (plan.planGroup === 'chat-only') {
        priceBox.appendChild(document.createTextNode(' '));
        const refNote = document.createElement('span');
        refNote.className = 'price-reference-note';
        refNote.textContent = '参考値(未確認)';
        priceBox.appendChild(refNote);
      }
      tdPriceDeal.appendChild(priceBox);

      // キャンペーン重要条件（適用中のみ、常に表示・隠さない）
      if (evalInfo && evalInfo.campaign_info && evalInfo.campaign_info.status === 'applied') {
        const campDiv = document.createElement('div');
        campDiv.className = 'tier-campaign-applied-row';
        const deltaText = (typeof evalInfo.campaign_delta === 'number')
          ? `／前回比 ${evalInfo.campaign_delta > 0 ? '+' : ''}${evalInfo.campaign_delta.toFixed(2)}点`
          : '';
        campDiv.textContent = `🎁 ${evalInfo.campaign_info.applied.title}：90日支払額 ${formatYen(evalInfo.campaign_info.applied.cost90d)}（おトク額 ${formatYen(evalInfo.campaign_info.applied.savingsYen)}）${deltaText}`;
        tdPriceDeal.appendChild(campDiv);
      }

      // 確認日 ＆ 作業時間目安（1回だけ）
      if (evalInfo) {
        const scoredDate = evalInfo.verified_at ? evalInfo.verified_at.slice(0, 10) : (evalInfo.scored_at ? evalInfo.scored_at.slice(0, 10) : '2026-10-20');
        const metaDiv = document.createElement('div');
        metaDiv.className = 'tier-meta-row sub-meta-row';
        let metaHtml = `<span class="tier-meta-date">📅 確認日: ${scoredDate}</span>`;
        if (evalInfo.work_capacity && evalInfo.work_capacity.hours_summary) {
          metaHtml += ` <span class="tier-meta-work-hours" title="${evalInfo.work_capacity.detail_hint || ''}">📋 利用枠: ${evalInfo.work_capacity.hours_summary}</span>`;
        }
        metaDiv.innerHTML = metaHtml;
        tdPriceDeal.appendChild(metaDiv);
      }

      // ステージ31: chat-onlyプラン（tier評価対象外・evalInfoなし）も価格セルに参考情報（確認日・要確認・出典URL）を表示
      if (!evalInfo && plan.planGroup === 'chat-only') {
        const refDealNote = buildDealNote(resolveDealInfo(plan.id));
        if (refDealNote) {
          const refDiv = document.createElement('div');
          refDiv.className = 'tier-meta-row sub-reference-detail';
          refDiv.textContent = refDealNote;
          tdPriceDeal.appendChild(refDiv);
        }
      }

      // 独自コスパ評価ボックス（4軸は開閉パネルへ）
      if (evalInfo) {
        const evalBox = document.createElement('div');
        evalBox.className = 'tier-evaluation-box';

        const evalBodyWrapper = document.createElement('div');
        evalBodyWrapper.className = 'tier-eval-body-wrapper';

        const evalMainContent = document.createElement('div');
        evalMainContent.className = 'tier-eval-main-content';

        // ヘッダー：評価タイトル + 総合点（1回だけ）
        const evalHeader = document.createElement('div');
        evalHeader.className = 'tier-eval-header';
        const evalTitle = document.createElement('span');
        evalTitle.textContent = '🎯 独自コスパ評価';
        const evalScore = document.createElement('span');
        evalScore.className = 'tier-header-score';
        if (evalInfo.total_score !== null && !evalInfo.is_pending) {
          evalScore.textContent = `総合点: ${evalInfo.total_score.toFixed(2)} 点`;
        } else {
          evalScore.textContent = '総合判定: 評価保留';
        }
        evalHeader.appendChild(evalTitle);
        evalHeader.appendChild(evalScore);
        evalMainContent.appendChild(evalHeader);

        // キャンペーン状態（評価ボックス内でも表示）
        if (evalInfo.campaign_info && evalInfo.campaign_info.status === 'applied') {
          const campDiv = document.createElement('div');
          campDiv.className = 'tier-campaign-applied-row';
          campDiv.style.cssText = 'background: #f0fdf4; border: 1px solid #86efac; color: #166534; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; margin: 4px 0;';
          campDiv.textContent = `🎁 新規キャンペーン適用中: ${evalInfo.campaign_info.applied.title} (90日支払額 ${formatYen(evalInfo.campaign_info.applied.cost90d)} / おトク額: ${formatYen(evalInfo.campaign_info.applied.savingsYen)})`;
          evalMainContent.appendChild(campDiv);
        } else if (evalInfo.campaign_info && evalInfo.campaign_info.status === 'expired') {
          const campDiv = document.createElement('div');
          campDiv.className = 'tier-campaign-expired-row';
          campDiv.style.cssText = 'background: #fef2f2; border: 1px solid #fca5a5; color: #991b1b; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; margin: 4px 0;';
          campDiv.textContent = '⚠️ キャンペーン: 期限切れ・要再計算 (通常価格で計算)';
          evalMainContent.appendChild(campDiv);
        }

        // 変動履歴
        if (evalInfo.history && evalInfo.history.length > 0) {
          const histDiv = document.createElement('div');
          histDiv.className = 'tier-history-row';
          histDiv.style.cssText = 'font-size: 0.78rem; color: #2563eb; margin: 2px 0;';
          histDiv.textContent = `📈 変動履歴: ${evalInfo.history[0].reason} (総合点前回比: +${evalInfo.history[0].score_diff.toFixed(2)}点)`;
          evalMainContent.appendChild(histDiv);
        }

        // 4軸を開閉パネルへ入れる（初期は閉じる）
        const breakdownPanel = document.createElement('div');
        breakdownPanel.className = 'tier-breakdown-panel';

        const breakdownToggle = document.createElement('button');
        breakdownToggle.type = 'button';
        breakdownToggle.className = 'tier-breakdown-toggle';
        breakdownToggle.textContent = '詳細・採点内訳を開く ▼';
        breakdownToggle.setAttribute('aria-expanded', 'false');
        breakdownToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpen = breakdownPanel.classList.toggle('is-open');
          breakdownToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
          breakdownToggle.textContent = isOpen ? '詳細・採点内訳を閉じる ▲' : '詳細・採点内訳を開く ▼';
        });
        evalMainContent.appendChild(breakdownToggle);

        // 4軸内訳グリッド
        const axisList = document.createElement('div');
        axisList.className = 'tier-axis-list';

        // ヘルパー: タップ/キーボード開閉可能な詳細注記を追加
        function attachInteractiveDetail(itemEl, detailText) {
          itemEl.setAttribute('tabindex', '0');
          itemEl.setAttribute('role', 'button');
          itemEl.setAttribute('aria-expanded', 'false');
          itemEl.title = 'クリック・タップまたはEnterキーで詳細注記を開閉できます';

          const toggleIcon = document.createElement('span');
          toggleIcon.className = 'axis-toggle-icon';
          toggleIcon.textContent = '▼';
          toggleIcon.setAttribute('aria-hidden', 'true');
          itemEl.appendChild(toggleIcon);

          const detailDiv = document.createElement('div');
          detailDiv.className = 'axis-interactive-detail';
          detailDiv.textContent = detailText;
          itemEl.appendChild(detailDiv);

          function toggleDetail(e) {
            e.stopPropagation();
            const isOpen = detailDiv.classList.toggle('is-open');
            itemEl.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            toggleIcon.textContent = isOpen ? '▲' : '▼';
          }

          itemEl.addEventListener('click', toggleDetail);
          itemEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggleDetail(e);
            }
          });
        }

        // 1. 支払負担 (35点)
        const ax1 = document.createElement('div');
        ax1.className = 'tier-axis-item';
        const ax1Lbl = document.createElement('span');
        ax1Lbl.className = 'axis-label';
        ax1Lbl.textContent = '① 支払負担 (35点): ';
        const ax1Val = document.createElement('span');
        const pScores = evalInfo.scores ? evalInfo.scores.payment : null;
        if (pScores && pScores.score !== null) {
          ax1Val.className = 'axis-value';
          const costStr = pScores.cost_90d_yen ? formatYen(pScores.cost_90d_yen) : '概算値';
          const isJpyNative = plan.id === 'google-ai-pro';
          const taxCurrencyNote = isJpyNative
            ? '日本円表示の公式表示価格(税の扱いは各社の表示による)。他のUSD表示プランの概算とは基準が異なります'
            : '公式表示価格(税の扱いは各社の表示による)を指定為替で換算した90日概算。実際の請求額や為替手数料・消費税等の請求条件により請求額は変動します';
          ax1Val.textContent = `${pScores.score.toFixed(2)} 点 (90日 ${costStr})`;
          const ax1ConstNote = document.createElement('span');
          ax1ConstNote.className = 'axis-constant-note';
          ax1ConstNote.textContent = '※公式表示価格(税の扱いは各社表示による)の概算・実請求額は異なる場合あり';
          ax1.appendChild(ax1Lbl);
          ax1.appendChild(ax1Val);
          ax1.appendChild(ax1ConstNote);
          // ステージ21: cursor-plusのみ年払い価格を補足表示（最小限変更・他プラン非表示）
          let annualNote = '';
          if (plan.id === 'cursor-plus') {
            annualNote = '年払い $80/年（Help Docs記載）。';
          }
          // ステージ31: 参考情報生成は共通ヘルパーへ移行（ステージ30と同一文言・データ駆動・最小変更）
          const dealNoteText = buildDealNote(resolveDealInfo(plan.id));
          const dealNote = dealNoteText ? ` ${dealNoteText}` : '';
          attachInteractiveDetail(ax1, `【支払負担 詳細】90日概算 ${costStr}。${annualNote}${taxCurrencyNote}。実際の決済時の為替レート・手数料・消費税等の請求条件により請求額は変動します。${dealNote}`);
        } else {
          ax1Val.className = 'axis-value axis-pending';
          ax1Val.textContent = '保留 (公式未確認)';
          ax1.appendChild(ax1Lbl);
          ax1.appendChild(ax1Val);
          attachInteractiveDetail(ax1, '【支払負担 詳細】公式ドキュメントで現行料金が確認できていないため評価保留としています。');
        }
        axisList.appendChild(ax1);

        // 2. 利用枠仕様 (30点)
        const ax2 = document.createElement('div');
        ax2.className = 'tier-axis-item';
        const ax2Lbl = document.createElement('span');
        ax2Lbl.className = 'axis-label';
        ax2Lbl.textContent = '② 利用枠仕様 (30点): ';
        const ax2Val = document.createElement('span');
        const qScores = evalInfo.scores ? evalInfo.scores.quota : null;
        const qScore = qScores ? qScores.score : null;
        if (qScore !== null && qScore !== undefined) {
          ax2Val.className = 'axis-value';
          let shortQ = '公表定量枠';
          if (qScore === 10.0) shortQ = '動的セッション枠';
          if (qScores && typeof qScores.label === 'string' && qScores.label) shortQ = qScores.label;
          if (plan.id === 'opencode-go') shortQ = '月$15〜$60定量枠';
          if (plan.id === 'github-copilot') shortQ = '1,500クレジット';
          if (plan.id === 'zai-glm-coding') shortQ = '週10,000クレジット';
          ax2Val.textContent = `${qScore.toFixed(2)} 点 (${shortQ})`;
          const ax2ConstNote = document.createElement('span');
          ax2ConstNote.className = 'axis-constant-note';
          ax2ConstNote.textContent = '※利用枠の公表仕様（動的制限含む）の概算';
          ax2.appendChild(ax2Lbl);
          ax2.appendChild(ax2Val);
          ax2.appendChild(ax2ConstNote);
          let fullQNote = (evalInfo.scores && evalInfo.scores.quota && evalInfo.scores.quota.note) || (qScores ? qScores.reason : '') || '公開仕様による評価';
          if (plan.id === 'opencode-go') {
            fullQNote = '【モデル別上限額の内訳】オープン系モデル(Kimi K2.7 Code・MiniMax M3・Qwen3.7 Plus・GLM-5.3-Flash等)各月$60上限、プロプライエタリ系モデル(Claude/GPT等)各月$15上限（合計 $15〜$60）。5時間20%・週次50%・月次100%の定量枠公表(出典: opencode.ai/v2/docs/console/go/)';
          } else if (qScore === 10.0) {
            fullQNote += ' (※動的fair use制限を同一区分として扱っており、メッセージ頻度や混雑時許容量の詳細差を区別できない粗い採点ルールとなっています)';
          }
          if (evalInfo.work_capacity && evalInfo.work_capacity.detail_hint) {
            fullQNote += ` 【利用枠仕様】${evalInfo.work_capacity.hours_summary}（${evalInfo.work_capacity.detail_hint}）`;
          }
          attachInteractiveDetail(ax2, `【利用枠仕様 詳細】${trimJaEnd(fullQNote)}。※実際の開発作業における実効作業量や生成コード品質を保証するものではありません。`);
        } else {
          ax2Val.className = 'axis-value axis-pending';
          ax2Val.textContent = '保留 (未確定)';
          ax2.appendChild(ax2Lbl);
          ax2.appendChild(ax2Val);
          attachInteractiveDetail(ax2, '【利用枠仕様 詳細】公式ドキュメントで枠仕様・リセット周期が未確定のため評価保留としています。');
        }
        axisList.appendChild(ax2);

        // 3. 用途適合機能 (25点)
        const ax3 = document.createElement('div');
        ax3.className = 'tier-axis-item';
        const ax3Lbl = document.createElement('span');
        ax3Lbl.className = 'axis-label';
        ax3Lbl.textContent = '③ 用途適合機能 (25点): ';
        const ax3Val = document.createElement('span');
        const fScore = evalInfo.scores && evalInfo.scores.fit ? evalInfo.scores.fit.score : null;
        if (fScore !== null && fScore !== undefined) {
          ax3Val.className = 'axis-value';
          ax3Val.textContent = `${fScore.toFixed(2)} 点 (IDE/CLI/Agent)`;
          const ax3ConstNote = document.createElement('span');
          ax3ConstNote.className = 'axis-constant-note';
          ax3ConstNote.textContent = '※IDE/CLI/Agent機能の判定(モデル品質非評価)';
          ax3.appendChild(ax3Lbl);
          ax3.appendChild(ax3Val);
          ax3.appendChild(ax3ConstNote);
          let fitDetail = '【用途適合機能 詳細】自律エージェント、IDE直接統合、コマンド実行支援に対応確認。※機能有無の公開情報に基づく独自指標による判定であり、生成されるコードの品質や知能の評価ではありません。';
          const fitExclusions = evalInfo.scores.fit.exclusions;
          if (Array.isArray(fitExclusions) && fitExclusions.length > 0) {
            fitDetail += ' ※このプランに含まれない機能: ' + fitExclusions.join(' / ') + '。';
          }
          attachInteractiveDetail(ax3, fitDetail);
        } else {
          ax3Val.className = 'axis-value axis-pending';
          ax3Val.textContent = '保留 (確認中)';
          ax3.appendChild(ax3Lbl);
          ax3.appendChild(ax3Val);
          attachInteractiveDetail(ax3, '【用途適合機能 詳細】IDE自律機能等の公式提供条件を確認中のため評価保留としています。');
        }
        axisList.appendChild(ax3);

        // 4. 制限後継続性 (10点)
        const ax4 = document.createElement('div');
        ax4.className = 'tier-axis-item';
        const ax4Lbl = document.createElement('span');
        ax4Lbl.className = 'axis-label';
        ax4Lbl.textContent = '④ 制限後継続性 (10点): ';
        const ax4Val = document.createElement('span');
        const cScore = evalInfo.scores && evalInfo.scores.continuity ? evalInfo.scores.continuity.score : null;
        if (cScore !== null && cScore !== undefined) {
          ax4Val.className = 'axis-value';
          let shortC = 'リセット制';
          if (cScore === 7.0) shortC = '5h動的回復';
          if (cScore === 2.0) shortC = '翌月1日リセット';
          ax4Val.textContent = `${cScore.toFixed(2)} 点 (${shortC})`;
          const ax4ConstNote = document.createElement('span');
          ax4ConstNote.className = 'axis-constant-note';
          ax4ConstNote.textContent = '※制限後のリセット周期・回復仕様';
          ax4.appendChild(ax4Lbl);
          ax4.appendChild(ax4Val);
          ax4.appendChild(ax4ConstNote);
          attachInteractiveDetail(ax4, `【制限後継続性 詳細】${trimJaEnd((evalInfo.scores.continuity && evalInfo.scores.continuity.reason) || '仕様確認済み')}。上限超過時の回復・リセット規則を公開情報に基づく独自指標で評価しています。`);
        } else {
          ax4Val.className = 'axis-value axis-pending';
          ax4Val.textContent = '保留 (未確認)';
          ax4.appendChild(ax4Lbl);
          ax4.appendChild(ax4Val);
          attachInteractiveDetail(ax4, '【制限後継続性 詳細】リセット規則や超過時課金仕様が未確認のため評価保留としています。');
        }
        axisList.appendChild(ax4);

        breakdownPanel.appendChild(axisList);

        // 評価保留の不足項目一覧は開閉パネル内へ移動（常時表示は「評価保留」+要約1行のみ）
        if (evalInfo.is_pending && evalInfo.pending_reasons && evalInfo.pending_reasons.length > 0) {
          const pendingBox = document.createElement('div');
          pendingBox.className = 'tier-pending-box';
          const pTitle = document.createElement('span');
          pTitle.className = 'pending-title';
          pTitle.textContent = '⚠️ 評価保留の理由 (不足項目):';
          pendingBox.appendChild(pTitle);
          const pUl = document.createElement('ul');
          evalInfo.pending_reasons.forEach(reason => {
            const pLi = document.createElement('li');
            pLi.textContent = reason;
            pUl.appendChild(pLi);
          });
          pendingBox.appendChild(pUl);

          // 保留プランの取得済み情報と参考試算の解説
          if (evalInfo.plan_id === 'kimi-coding') {
            const kimiNote = document.createElement('div');
            kimiNote.className = 'pending-extra-note';
            kimiNote.innerHTML = '<strong>💡 取得済み情報と参考試算:</strong><br>' +
              '・利用枠（10点）・機能適合（25点）・継続性（7点）の3軸は公式確認済みです。<br>' +
              '・中国国内公式（99元/月 ≒ 約2,170円）適用時の試算: <strong>総合 61.81点（Bランク相当）</strong><br>' +
              '・国際標準（ USD/月 ≒ 約2,945円）適用時の試算: <strong>総合 56.39点（Cランク相当）</strong>';
            pendingBox.appendChild(kimiNote);
          } else if (evalInfo.plan_id === 'cursor-pro') {
            const cursorNote = document.createElement('div');
            cursorNote.className = 'pending-extra-note';
            cursorNote.innerHTML = '<strong>💡 プラン状況:</strong><br>' +
              '・Cursorの新料金体系移行に伴い、現在は新規受付停止（既存のみ維持）となっています。<br>' +
              '・新規検討の方は、確定ランク対象の <strong>Cursor Plus ()</strong> または <strong>Cursor Premium ()</strong> をご覧ください。';
            pendingBox.appendChild(cursorNote);
          }

          breakdownPanel.appendChild(pendingBox);
        }

        // メタ行（確認日・短い確認状態）
        const metaDiv2 = document.createElement('div');
        metaDiv2.className = 'tier-meta-row';
        const scoredDate2 = evalInfo.verified_at ? evalInfo.verified_at.slice(0, 10) : (evalInfo.scored_at ? evalInfo.scored_at.slice(0, 10) : '2026-10-20');
        metaDiv2.innerHTML = `<span class="tier-meta-date">📅 確認日: ${scoredDate2}</span> <span class="tier-meta-state">※ 公式表示価格の90日概算（実請求額とは異なります）／独自指標</span>`;
        breakdownPanel.appendChild(metaDiv2);

        // モバイルカードでは、横並びだったエージェント機能・特徴を詳細内だけに集約する。
        // 開閉パネル内に置くことで、閉じている間は行の高さに一切寄与しない。
        const mobileDetails = document.createElement('div');
        mobileDetails.className = 'mobile-plan-details';
        const agentDetail = document.createElement('p');
        agentDetail.className = 'mobile-detail-item';
        agentDetail.innerHTML = '<strong>エージェント機能:</strong> ';
        agentDetail.appendChild(document.createTextNode(`${plan.agentBadge || '未確認'} ${plan.agentDesc || ''}`.trim()));
        mobileDetails.appendChild(agentDetail);
        const featureDetail = document.createElement('p');
        featureDetail.className = 'mobile-detail-item';
        featureDetail.innerHTML = '<strong>特徴・用途:</strong> ';
        featureDetail.appendChild(document.createTextNode(plan.features || '公開情報を確認中です。'));
        mobileDetails.appendChild(featureDetail);
        breakdownPanel.appendChild(mobileDetails);

        evalMainContent.appendChild(breakdownPanel);
        evalBodyWrapper.appendChild(evalMainContent);
        evalBox.appendChild(evalBodyWrapper);
        tdPriceDeal.appendChild(evalBox);
      }

      tr.appendChild(tdPriceDeal);

      // ---------- 3. エージェント機能（簡潔・スマホは短い要約1行） ----------
      const tdAgent = document.createElement('td');
      tdAgent.className = 'sub-agent-cell';
      const agentHeader = document.createElement('div');
      agentHeader.className = 'agent-header-row';
      const agentBadge = document.createElement('span');
      agentBadge.className = 'sub-agent-badge ' + (plan.hasAgent ? 'agent-has' : 'agent-none');
      agentBadge.textContent = plan.agentBadge;
      agentHeader.appendChild(agentBadge);
      tdAgent.appendChild(agentHeader);

      if (plan.agentDesc) {
        const agentDesc = document.createElement('div');
        agentDesc.className = 'agent-desc-text';
        agentDesc.textContent = plan.agentDesc;
        tdAgent.appendChild(agentDesc);
      }
      tr.appendChild(tdAgent);

      // ---------- 4. 特徴・おすすめ用途（簡潔） ----------
      const tdDesc = document.createElement('td');
      tdDesc.className = 'sub-desc-cell';
      const featDiv = document.createElement('div');
      featDiv.className = 'sub-features';
      featDiv.textContent = plan.features;
      tdDesc.appendChild(featDiv);
      tr.appendChild(tdDesc);

      return tr;
    }

    // JSON評価をプランへ結合し、確定ランクと評価保留を混在させない。
    const items = filtered.map(plan => {
      const record = tierEvaluationData && Array.isArray(tierEvaluationData.plans)
        ? tierEvaluationData.plans.find(p => p.plan_id === plan.id) : null;
      const evalInfo = record ? { ...record } : null;
      if (evalInfo) {
        // 価格は JSON を最優先（ハードコード値で上書きしない）。
        // JSON に price_usd キーが存在する場合は null でもそのまま尊重し、
        // 「価格未確定」として扱う（勝手にプラン定義の値へフォールバックしない）。
        if (Object.prototype.hasOwnProperty.call(record, 'price_usd')) {
          evalInfo.price_usd = (typeof record.price_usd === 'number') ? record.price_usd : null;
        } else {
          evalInfo.price_usd = (typeof plan.priceUSD === 'number') ? plan.priceUSD : null;
        }
        // 円建て固定価格（Google AI Pro 等）は JSON の price_jpy を尊重する。
        if (typeof record.price_jpy === 'number') {
          evalInfo.price_jpy = record.price_jpy;
        } else {
          delete evalInfo.price_jpy;
        }
        // 新規契約キャンペーンの判定（verified かつ期間有効のみ適用）。
        evalInfo.campaign_info = resolveCampaignInfo(plan, evalInfo);
        // キャンペーン適用時は割引後の90日費用で支払負担点・総合点・ランクを再計算する。
        // 評価保留プランは点数を付けない（applyExchangeRateToEval 内で is_pending を除外）。
        const applied = evalInfo.campaign_info && evalInfo.campaign_info.status === 'applied'
          ? evalInfo.campaign_info.applied : null;
        const discountedCost = (applied && typeof applied.cost90d === 'number') ? applied.cost90d : null;
        // 為替レートに応じた円換算と支払負担スコアの再計算（為替変更を料金・点数へ反映）。
        applyExchangeRateToEval(evalInfo, discountedCost);
        // 前回比（キャンペーン適用による点数変化）を履歴として保持する。
        if (applied && typeof record.total_score === 'number' && typeof evalInfo.total_score === 'number') {
          const delta = Math.round((evalInfo.total_score - record.total_score) * 100) / 100;
          if (delta !== 0) {
            evalInfo.campaign_delta = delta;
            evalInfo.campaign_prev_score = record.total_score;
          }
        }
      }
      return { plan, evalInfo, rankDisplay: '' };
    });
    // 順位は常に総合点基準で算出する（並び順を変えても順位の意味は変えない）
    const byScore = items.filter(item => item.evalInfo && !item.evalInfo.is_pending)
      .sort((a, b) => b.evalInfo.total_score - a.evalInfo.total_score);
    byScore.forEach(item => {
      const score = item.evalInfo.total_score;
      const firstIdx = byScore.findIndex(o => o.evalInfo.total_score === score);
      const sameCount = byScore.filter(o => o.evalInfo.total_score === score).length;
      const pos = firstIdx + 1;
      item.rankDisplay = sameCount > 1 ? `${pos}位タイ` : `${pos}位`;
    });
    // 表示順は選択された並び順に従う
    const rankedItems = byScore.slice();
    if (activeSubSort === 'name') {
      rankedItems.sort((a, b) => (a.plan.name || '').localeCompare(b.plan.name || '', 'ja'));
    } else if (activeSubSort === 'price') {
      rankedItems.sort((a, b) => {
        const pA = typeof a.plan.priceUSD === 'number' ? a.plan.priceUSD : 9999;
        const pB = typeof b.plan.priceUSD === 'number' ? b.plan.priceUSD : 9999;
        return pA - pB;
      });
    }
    const pendingItems = items.filter(item => !item.evalInfo || item.evalInfo.is_pending);
    sortList(pendingItems);

    function appendGroup(title, description, cssClass, groupItems) {
      if (!groupItems.length) return;
      const groupRow = document.createElement('tr');
      groupRow.className = `sub-group-row ${cssClass}`;
      const groupCell = document.createElement('td');
      groupCell.className = `sub-group-cell ${cssClass === 'ranked-group-row' ? 'ranked-group-cell verified-group-cell' : 'unverified-group-cell'}`;
      groupCell.colSpan = 4;
      groupCell.innerHTML = `<strong>${title}</strong><span class="group-header-desc">${description}</span>`;
      groupRow.appendChild(groupCell);
      frag.appendChild(groupRow);
      groupItems.forEach(item => frag.appendChild(buildPlanRow(item, cssClass === 'ranked-group-row')));
    }
    appendGroup('🎯 ランク確定プラン（独自コスパ評価・総合点順）', '【共通注記】4軸の公開情報に基づく独自指標です。各AIモデルの知能・生成コード品質は含みません。', 'ranked-group-row', rankedItems);
    appendGroup('📋 評価保留・未確認プラン（確認待ち）', '4軸のいずれかが未確認、または公式資料間で表記相違があるため、S/A/B/Cランクには含めません。', 'unverified-group-row', pendingItems);
    dom.subTableBody.appendChild(frag);
  }

  function switchMode(mode) {
    activeMode = mode;
    dom.modeNavBtns.forEach(btn => {
      const target = btn.getAttribute('data-target');
      if ((mode === 'api' && target === 'section-api') || (mode === 'sub' && target === 'section-sub')) {
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
      } else {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
      }
    });

    if (mode === 'api') {
      dom.sectionApi.style.display = 'block';
      dom.sectionSub.style.display = 'none';
    } else {
      dom.sectionApi.style.display = 'none';
      dom.sectionSub.style.display = 'block';
      renderSubscriptions();
    }
  }

  /**
   * イベントリスナー設定
   */
  function initEventListeners() {
    // -1. テーマ切り替えボタン（ダーク ↔ ライト）
    if (dom && dom.themeToggleBtn) {
      dom.themeToggleBtn.addEventListener('click', toggleTheme);
    }

    // 0. メインモード切り替え（API表 vs サブスク表）
    dom.modeNavBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-target');
        switchMode(target === 'section-sub' ? 'sub' : 'api');
      });
    });

    // 1. 生データ更新ボタン
    dom.fetchLiveBtn.addEventListener('click', fetchLiveModels);

    // 2. 為替レート変更
    dom.exchangeRateInput.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      if (!isNaN(val) && val >= 50 && val <= 500) {
        exchangeRate = Math.round(val);
        saveExchangeRate(exchangeRate);
        render();
        // 為替はサブスク表の料金・点数にも影響するため再描画する
        renderSubscriptions();
      }
    });

    // 3. API表並び替えセレクト
    dom.sortSelect.addEventListener('change', (e) => {
      activeSort = e.target.value;
      render();
    });

    // 3.5. 定額サブスク表並び替えセレクト
    if (dom.subSortSelect) {
      dom.subSortSelect.addEventListener('change', (e) => {
        activeSubSort = e.target.value;
        renderSubscriptions();
      });
    }

    // 3.6. 🎓 学割トグル（学生・教員向けスコア・バッジ・特典行の切り替え）
    if (dom.studentToggle) {
      dom.studentToggle.checked = includeStudentDiscount;
      dom.studentToggle.addEventListener('change', (e) => {
        includeStudentDiscount = Boolean(e.target.checked);
        renderSubscriptions();
      });
    }

    // 4. APIモデル区分フィルタタブ（all / flagship / light）
    dom.filterTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        activeTierFilter = tab.getAttribute('data-tier') || 'all';
        render();
      });
    });

    // 5. サブスク区分フィルタタブ（agent-all / coding-agent / native-agent / entry / deal / chat-only）
    //    絞り込みUIは <details class="filter-panel"> の1つに統合済み（開閉はネイティブ動作）。
    if (dom.campaignToggle) {
      dom.campaignToggle.checked = applyNewUserCampaign;
      dom.campaignToggle.addEventListener('change', (e) => {
        applyNewUserCampaign = Boolean(e.target.checked);
        renderSubscriptions();
      });
    }

    dom.subFilterTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        activeSubTierFilter = tab.getAttribute('data-subtier') || 'agent-all';
        renderSubscriptions();
      });
    });
  }

  /**
   * 初期化
   */
  function init() {
    initDom();
    initTheme();
    loadSettingsAndCache();
    loadTierData();
    loadCampaignsData();
    initEventListeners();
    render();
    switchMode('sub');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();