export type Locale = "en" | "zh-CN";

export type TranslationMap = { [key: string]: string | TranslationMap };

export interface OnboardingTranslations {
  // Security warning
  security: {
    header: string;
    warning: string[];
    confirm: string;
  };
  // Wizard headers
  wizard: {
    intro: string;
    header: string[];
  };
  // Flow selection
  flow: {
    message: string;
    quickstart: {
      label: string;
      hint: string;
    };
    advanced: {
      label: string;
      hint: string;
    };
  };
  // Config handling
  config: {
    existingDetected: string;
    handlingMessage: string;
    keep: string;
    modify: string;
    reset: string;
    resetScope: string;
    configOnly: string;
    configCredsSessions: string;
    fullReset: string;
    invalid: string;
  };
  // Gateway setup
  gateway: {
    modeMessage: string;
    local: {
      label: string;
      hintReachable: string;
      hintUnreachable: string;
    };
    remote: {
      label: string;
      hintNoUrl: string;
      hintReachable: string;
      hintUnreachable: string;
    };
    quickstartNote: string;
    keepingSettings: string;
    port: string;
    bind: string;
    bindLoopback: string;
    bindLan: string;
    bindAuto: string;
    bindCustom: string;
    bindTailnet: string;
    customIp: string;
    auth: string;
    authToken: string;
    authPassword: string;
    tailscale: string;
    tailscaleOff: string;
    tailscaleServe: string;
    tailscaleFunnel: string;
    directToChannels: string;
    configured: string;
  };
  // Workspace
  workspace: {
    message: string;
  };
  // Channels
  channels: {
    header: string;
    skipping: string;
    configureNow: string;
    selectQuickstart: string;
    selectMultiple: string;
    finished: string;
    done: string;
    skipForNow: string;
    addLater: string;
    alreadyConfigured: string;
    actions: {
      modify: string;
      disable: string;
      disableHint: string;
      delete: string;
      skip: string;
      skipHint: string;
    };
    account: string;
    deleteAccount: string;
    dmPolicy: {
      message: string;
      label: string;
      pairing: string;
      pairingHint: string;
      allowlist: string;
      allowlistHint: string;
      open: string;
      openHint: string;
      disabled: string;
      disabledHint: string;
    };
  };
  // Skills
  skills: {
    header: string;
    skipping: string;
    status: {
      title: string;
      eligible: string;
      missingRequirements: string;
      unsupportedOs: string;
      blockedByAllowlist: string;
    };
    configureNow: string;
    installDependencies: string;
    skipForNow: string;
    skipHint: string;
    install: string;
    installing: string;
    installed: string;
    installedWithWarnings: string;
    installFailed: string;
    brew: {
      title: string;
      message: string[];
      showCommand: string;
      installTitle: string;
      run: string;
    };
    nodeManager: {
      message: string;
    };
    setApiKey: string;
    enterApiKey: string;
    required: string;
    tip: string;
    docs: string;
  };
  // Common messages
  common: {
    continue: string;
    cancel: string;
    yes: string;
    no: string;
  };
  // Hooks
  hooks: {
    header: string;
    intro: string[];
    learnMore: string;
    noHooksAvailable: {
      message: string;
      title: string;
    };
    enableHooks: string;
    skipForNow: string;
    configured: {
      title: string;
      enabled: string;
      hooks: string;
      manageHooks: string;
      list: string;
      enable: string;
      disable: string;
    };
  };
  // Platform warnings
  platform: {
    windowsDetected: string[];
  };
  // Language selection
  language: {
    message: string;
    english: string;
    chinese: string;
  };
  // Finalize
  finalize: {
    systemd: {
      title: string;
      unavailable: string;
      lingerReason: string;
    };
    gateway: {
      installService: string;
      serviceRuntime: string;
      quickstartNote: string;
      alreadyInstalled: string;
      restart: string;
      reinstall: string;
      skip: string;
      restarting: string;
      restarted: string;
      uninstalling: string;
      uninstalled: string;
      preparing: string;
      installing: string;
      installed: string;
      installFailed: string;
      title: string;
      unavailableNote: string;
    };
    health: {
      title: string;
      failed: string;
      docs: string[];
    };
    apps: {
      title: string;
      message: string[];
    };
    controlUi: {
      title: string;
      webUi: string;
      webUiWithToken: string;
      gatewayWs: string;
      reachable: string;
      notDetected: string;
      docs: string;
    };
    hatch: {
      title: string;
      note: string[];
      wakeMessage: string;
      message: string;
      tui: string;
      web: string;
      later: string;
    };
    token: {
      title: string;
      message: string[];
    };
    dashboard: {
      title: string;
      linkWithToken: string;
      opened: string;
      copyPaste: string;
      ready: string;
      later: string;
    };
    workspace: {
      title: string;
      message: string[];
    };
    security: {
      title: string;
      message: string;
    };
    webSearch: {
      title: string;
      enabled: string[];
      disabled: string[];
    };
    whatNow: {
      title: string;
      message: string;
    };
    outro: {
      dashboardOpened: string;
      seededInBackground: string;
      complete: string;
    };
  };
}

export interface I18nContext {
  locale: Locale;
  t: OnboardingTranslations;
}
