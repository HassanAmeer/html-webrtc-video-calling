/**
 * Empirical Challenger Test Harness for Milestone 1
 * Tests:
 * 1. SharedPreferences Lifecycle & State Machine Transitions (Cold Start, Later, Settings, Dismiss, Cancel, Race conditions)
 * 2. getPermissionsStatus() and isServiceRunningOrEnabled() accuracy with sInstance == null and sInstance != null
 * 3. Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES edge case parsing
 */

const assert = require('assert');

console.log("=================================================================");
console.log("RUNNING EMPIRICAL CHALLENGER TEST SUITE FOR MILESTONE 1");
console.log("=================================================================\n");

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
    totalTests++;
    try {
        fn();
        console.log(`[PASS] ${name}`);
        passedTests++;
    } catch (e) {
        console.error(`[FAIL] ${name}: ${e.message}`);
        console.error(e.stack);
    }
}

// ----------------------------------------------------------------------
// Mocking Android SharedPreferences & System State
// ----------------------------------------------------------------------

class MockSharedPreferences {
    constructor() {
        this.data = new Map();
    }
    getBoolean(key, defValue) {
        return this.data.has(key) ? this.data.get(key) : defValue;
    }
    edit() {
        const self = this;
        const pending = new Map();
        return {
            putBoolean(k, v) {
                pending.set(k, v);
                return this;
            },
            apply() {
                for (const [k, v] of pending.entries()) {
                    self.data.set(k, v);
                }
            },
            commit() {
                this.apply();
                return true;
            }
        };
    }
}

class MockContext {
    constructor(pkgName = "com.tokendeal.vremote") {
        this.packageName = pkgName;
        this.prefs = new Map();
        this.secureSettings = new Map();
    }
    getPackageName() {
        return this.packageName;
    }
    getSharedPreferences(name, mode) {
        if (!this.prefs.has(name)) {
            this.prefs.set(name, new MockSharedPreferences());
        }
        return this.prefs.get(name);
    }
    setSecureInt(key, val) {
        this.secureSettings.set(key, val);
    }
    getSecureInt(key, def) {
        return this.secureSettings.has(key) ? this.secureSettings.get(key) : def;
    }
    setSecureString(key, val) {
        this.secureSettings.set(key, val);
    }
    getSecureString(key) {
        return this.secureSettings.has(key) ? this.secureSettings.get(key) : null;
    }
}

// ----------------------------------------------------------------------
// RemoteAccessibilityService Logic Model
// ----------------------------------------------------------------------

class RemoteAccessibilityServiceMock {
    static sInstance = null;

    static isServiceRunning() {
        return this.sInstance !== null;
    }

    static isAccessibilityServiceEnabled(context) {
        if (!context) return false;
        try {
            const accessibilityEnabled = context.getSecureInt("accessibility_enabled", 0);
            if (accessibilityEnabled !== 1) {
                return false;
            }

            const services = context.getSecureString("enabled_accessibility_services");
            if (!services || services.trim() === "") {
                return false;
            }

            const pkg = context.getPackageName();
            const expectedString1 = `${pkg}/com.tokendeal.vremote.RemoteAccessibilityService`;
            const expectedString2 = `${pkg}/.RemoteAccessibilityService`;
            const simpleTarget = `${pkg}/RemoteAccessibilityService`;

            const parts = services.split(':');
            for (let part of parts) {
                if (!part) continue;
                const trimmed = part.trim();
                if (!trimmed) continue;

                if (trimmed.toLowerCase() === expectedString1.toLowerCase() ||
                    trimmed.toLowerCase() === expectedString2.toLowerCase() ||
                    trimmed.includes(simpleTarget) ||
                    (trimmed.startsWith(pkg + "/") && trimmed.includes("RemoteAccessibilityService"))) {
                    return true;
                }

                // ComponentName unflatten
                const slashIdx = trimmed.indexOf('/');
                if (slashIdx > 0) {
                    const cPkg = trimmed.substring(0, slashIdx);
                    let cCls = trimmed.substring(slashIdx + 1);
                    if (cCls.startsWith('.')) {
                        cCls = cPkg + cCls;
                    }
                    if (cPkg.toLowerCase() === pkg.toLowerCase()) {
                        if (cCls.toLowerCase() === "com.tokendeal.vremote.RemoteAccessibilityService".toLowerCase() ||
                            cCls.endsWith("RemoteAccessibilityService")) {
                            return true;
                        }
                    }
                }
            }
        } catch (ignored) {}
        return false;
    }

    static isServiceRunningOrEnabled(context) {
        return this.isServiceRunning() || this.isAccessibilityServiceEnabled(context);
    }

    static simulateConnect(context) {
        this.sInstance = new RemoteAccessibilityServiceMock();
        try {
            const prefs = context.getSharedPreferences("VRemoteDevicePrefs", 0);
            prefs.edit().putBoolean("has_prompted_accessibility", true).apply();
        } catch (ignored) {}
    }

    static simulateDisconnect() {
        this.sInstance = null;
    }
}

// ----------------------------------------------------------------------
// MainActivity Logic Model
// ----------------------------------------------------------------------

class MainActivityMock {
    constructor(context) {
        this.context = context;
        this.PREF_NAME = "VRemoteDevicePrefs";
        this.KEY_HAS_PROMPTED_ACCESSIBILITY = "has_prompted_accessibility";
        this.hasPromptedAccessibility = false;
        this.dialogShown = false;
        this.dialogScheduled = false;
        this.dialogCallbacks = null;
    }

    onCreate() {
        try {
            const prefs = this.context.getSharedPreferences(this.PREF_NAME, 0);
            this.hasPromptedAccessibility = prefs.getBoolean(this.KEY_HAS_PROMPTED_ACCESSIBILITY, false);
        } catch (ignored) {}
    }

    onResume() {
        this.checkAccessibilityPrompt();
    }

    checkAccessibilityPrompt() {
        const prefs = this.context.getSharedPreferences(this.PREF_NAME, 0);
        const alreadyPrompted = prefs.getBoolean(this.KEY_HAS_PROMPTED_ACCESSIBILITY, false);

        if (this.hasPromptedAccessibility || alreadyPrompted) {
            this.hasPromptedAccessibility = true;
            return;
        }

        if (RemoteAccessibilityServiceMock.isServiceRunningOrEnabled(this.context)) {
            this.hasPromptedAccessibility = true;
            prefs.edit().putBoolean(this.KEY_HAS_PROMPTED_ACCESSIBILITY, true).apply();
            return;
        }

        this.hasPromptedAccessibility = true;
        prefs.edit().putBoolean(this.KEY_HAS_PROMPTED_ACCESSIBILITY, true).apply();

        this.dialogScheduled = true;
        this.dialogCallbacks = {
            onPositive: () => {
                this.hasPromptedAccessibility = true;
                prefs.edit().putBoolean(this.KEY_HAS_PROMPTED_ACCESSIBILITY, true).apply();
            },
            onNegative: () => {
                this.hasPromptedAccessibility = true;
                prefs.edit().putBoolean(this.KEY_HAS_PROMPTED_ACCESSIBILITY, true).apply();
            },
            onDismiss: () => {
                this.hasPromptedAccessibility = true;
                prefs.edit().putBoolean(this.KEY_HAS_PROMPTED_ACCESSIBILITY, true).apply();
            },
            onCancel: () => {
                this.hasPromptedAccessibility = true;
                prefs.edit().putBoolean(this.KEY_HAS_PROMPTED_ACCESSIBILITY, true).apply();
            }
        };
    }

    // Trigger timer completion
    triggerDialogTimer(isFinishingOrDestroyed = false) {
        if (!this.dialogScheduled) return;
        if (isFinishingOrDestroyed) return;
        if (RemoteAccessibilityServiceMock.isServiceRunningOrEnabled(this.context)) {
            return;
        }
        this.dialogShown = true;
    }

    getPermissionsStatus() {
        const accOk = RemoteAccessibilityServiceMock.isServiceRunningOrEnabled(this.context);
        return {
            camera: "granted",
            microphone: "granted",
            storage: "granted",
            accessibility: accOk ? "granted" : "denied",
            background_service: "granted",
            battery_optimization: "granted",
            overlay: "granted",
            notifications: "granted"
        };
    }

    isAccessibilityRunning() {
        return RemoteAccessibilityServiceMock.isServiceRunningOrEnabled(this.context);
    }
}

// ----------------------------------------------------------------------
// Tests Execution
// ----------------------------------------------------------------------

// 1. Cold start: fresh install (service disabled, pref false)
runTest("Cold start - Fresh install prompts once and writes pref", () => {
    RemoteAccessibilityServiceMock.simulateDisconnect();
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 0);

    const act = new MainActivityMock(ctx);
    act.onCreate();
    assert.strictEqual(act.hasPromptedAccessibility, false);

    act.onResume();
    assert.strictEqual(act.dialogScheduled, true);
    assert.strictEqual(act.hasPromptedAccessibility, true);

    const prefs = ctx.getSharedPreferences("VRemoteDevicePrefs", 0);
    assert.strictEqual(prefs.getBoolean("has_prompted_accessibility", false), true, "Pref must be true immediately");

    act.triggerDialogTimer();
    assert.strictEqual(act.dialogShown, true, "Dialog must be shown");
});

// 2. Cold start: service ALREADY enabled in system settings
runTest("Cold start - Service already enabled in settings: permanently suppresses dialog", () => {
    RemoteAccessibilityServiceMock.simulateDisconnect();
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 1);
    ctx.setSecureString("enabled_accessibility_services", "com.tokendeal.vremote/com.tokendeal.vremote.RemoteAccessibilityService");

    const act = new MainActivityMock(ctx);
    act.onCreate();
    act.onResume();

    assert.strictEqual(act.dialogScheduled, false, "Dialog should NOT be scheduled");
    assert.strictEqual(act.dialogShown, false, "Dialog should NOT be shown");
    const prefs = ctx.getSharedPreferences("VRemoteDevicePrefs", 0);
    assert.strictEqual(prefs.getBoolean("has_prompted_accessibility", false), true, "Pref must be set to true");
});

// 3. Cold start: previous prompt acknowledged in SharedPreferences
runTest("Cold start - Previous prompt recorded in SharedPreferences suppresses dialog", () => {
    RemoteAccessibilityServiceMock.simulateDisconnect();
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 0);
    const prefs = ctx.getSharedPreferences("VRemoteDevicePrefs", 0);
    prefs.edit().putBoolean("has_prompted_accessibility", true).apply();

    const act = new MainActivityMock(ctx);
    act.onCreate();
    assert.strictEqual(act.hasPromptedAccessibility, true);

    act.onResume();
    assert.strictEqual(act.dialogScheduled, false);
    assert.strictEqual(act.dialogShown, false);
});

// 4. Dialog interaction: Positive Button ("Open Settings")
runTest("Dialog interaction - Positive button persists pref", () => {
    RemoteAccessibilityServiceMock.simulateDisconnect();
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 0);

    const act = new MainActivityMock(ctx);
    act.onCreate();
    act.onResume();
    act.triggerDialogTimer();

    act.dialogCallbacks.onPositive();
    const prefs = ctx.getSharedPreferences("VRemoteDevicePrefs", 0);
    assert.strictEqual(prefs.getBoolean("has_prompted_accessibility", false), true);

    // Simulate returning to app
    act.onResume();
    assert.strictEqual(act.dialogShown, true); // was shown from before, but not re-scheduled
});

// 5. Dialog interaction: Negative Button ("Later")
runTest("Dialog interaction - Negative button ('Later') persists pref", () => {
    RemoteAccessibilityServiceMock.simulateDisconnect();
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 0);

    const act = new MainActivityMock(ctx);
    act.onCreate();
    act.onResume();
    act.triggerDialogTimer();

    act.dialogCallbacks.onNegative();
    const prefs = ctx.getSharedPreferences("VRemoteDevicePrefs", 0);
    assert.strictEqual(prefs.getBoolean("has_prompted_accessibility", false), true);

    // Restart app (Cold start)
    const act2 = new MainActivityMock(ctx);
    act2.onCreate();
    act2.onResume();
    assert.strictEqual(act2.dialogScheduled, false, "Dialog must never show on subsequent restart");
});

// 6. Dialog interaction: Dismiss via Back button / Outside touch
runTest("Dialog interaction - Dismiss via Back or Outside touch persists pref", () => {
    RemoteAccessibilityServiceMock.simulateDisconnect();
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 0);

    const act = new MainActivityMock(ctx);
    act.onCreate();
    act.onResume();
    act.triggerDialogTimer();

    act.dialogCallbacks.onCancel();
    act.dialogCallbacks.onDismiss();

    const prefs = ctx.getSharedPreferences("VRemoteDevicePrefs", 0);
    assert.strictEqual(prefs.getBoolean("has_prompted_accessibility", false), true);

    // Restart app (Cold start)
    const act2 = new MainActivityMock(ctx);
    act2.onCreate();
    act2.onResume();
    assert.strictEqual(act2.dialogScheduled, false, "Dialog must never show after dismissal");
});

// 7. Timer race condition: Service turned on during 1200ms delay
runTest("Race condition - Service enabled during 1200ms delay aborts dialog", () => {
    RemoteAccessibilityServiceMock.simulateDisconnect();
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 0);

    const act = new MainActivityMock(ctx);
    act.onCreate();
    act.onResume();
    assert.strictEqual(act.dialogScheduled, true);

    // User or service binds during the 1.2s delay
    ctx.setSecureInt("accessibility_enabled", 1);
    ctx.setSecureString("enabled_accessibility_services", "com.tokendeal.vremote/.RemoteAccessibilityService");

    act.triggerDialogTimer();
    assert.strictEqual(act.dialogShown, false, "Dialog display must be aborted");
});

// 8. Service connection persistence
runTest("Service onServiceConnected writes has_prompted_accessibility", () => {
    RemoteAccessibilityServiceMock.simulateDisconnect();
    const ctx = new MockContext();
    const prefs = ctx.getSharedPreferences("VRemoteDevicePrefs", 0);
    assert.strictEqual(prefs.getBoolean("has_prompted_accessibility", false), false);

    RemoteAccessibilityServiceMock.simulateConnect(ctx);
    assert.strictEqual(RemoteAccessibilityServiceMock.isServiceRunning(), true);
    assert.strictEqual(prefs.getBoolean("has_prompted_accessibility", false), true);
});

// 9. getPermissionsStatus() with sInstance == null but service enabled in Settings
runTest("getPermissionsStatus() - Accurate 'granted' when sInstance == null and service enabled in Settings", () => {
    RemoteAccessibilityServiceMock.simulateDisconnect();
    assert.strictEqual(RemoteAccessibilityServiceMock.sInstance, null, "sInstance must be null");

    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 1);
    ctx.setSecureString("enabled_accessibility_services", "com.tokendeal.vremote/com.tokendeal.vremote.RemoteAccessibilityService");

    const act = new MainActivityMock(ctx);
    const status = act.getPermissionsStatus();
    assert.strictEqual(status.accessibility, "granted", "accessibility status must be granted even when sInstance is null");
    assert.strictEqual(act.isAccessibilityRunning(), true, "isAccessibilityRunning() must return true");
});

// 10. getPermissionsStatus() with sInstance != null
runTest("getPermissionsStatus() - Accurate 'granted' when sInstance != null even if settings not queried yet", () => {
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 0); // settings not updated or delayed
    RemoteAccessibilityServiceMock.simulateConnect(ctx);
    assert.strictEqual(RemoteAccessibilityServiceMock.sInstance !== null, true);

    const act = new MainActivityMock(ctx);
    const status = act.getPermissionsStatus();
    assert.strictEqual(status.accessibility, "granted");
    assert.strictEqual(act.isAccessibilityRunning(), true);
});

// 11. getPermissionsStatus() when both sInstance == null and service disabled in Settings
runTest("getPermissionsStatus() - Accurate 'denied' when service is completely off", () => {
    RemoteAccessibilityServiceMock.simulateDisconnect();
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 0);
    ctx.setSecureString("enabled_accessibility_services", "");

    const act = new MainActivityMock(ctx);
    const status = act.getPermissionsStatus();
    assert.strictEqual(status.accessibility, "denied");
    assert.strictEqual(act.isAccessibilityRunning(), false);
});

// 12. Adversarial parser challenge: String variations in enabled_accessibility_services
runTest("Adversarial parser - Multi-service colon-delimited string", () => {
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 1);
    ctx.setSecureString("enabled_accessibility_services",
        "com.google.android.marvin.talkback/.TalkBackService:com.tokendeal.vremote/com.tokendeal.vremote.RemoteAccessibilityService:com.dummy/.DummyService");
    assert.strictEqual(RemoteAccessibilityServiceMock.isAccessibilityServiceEnabled(ctx), true);
});

runTest("Adversarial parser - Short component format (.RemoteAccessibilityService)", () => {
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 1);
    ctx.setSecureString("enabled_accessibility_services", "com.tokendeal.vremote/.RemoteAccessibilityService");
    assert.strictEqual(RemoteAccessibilityServiceMock.isAccessibilityServiceEnabled(ctx), true);
});

runTest("Adversarial parser - Bare name format (RemoteAccessibilityService)", () => {
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 1);
    ctx.setSecureString("enabled_accessibility_services", "com.tokendeal.vremote/RemoteAccessibilityService");
    assert.strictEqual(RemoteAccessibilityServiceMock.isAccessibilityServiceEnabled(ctx), true);
});

runTest("Adversarial parser - Trailing and leading colons with whitespace", () => {
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 1);
    ctx.setSecureString("enabled_accessibility_services", " : com.tokendeal.vremote/.RemoteAccessibilityService : ");
    assert.strictEqual(RemoteAccessibilityServiceMock.isAccessibilityServiceEnabled(ctx), true);
});

runTest("Adversarial parser - Malicious similar package name rejected", () => {
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 1);
    ctx.setSecureString("enabled_accessibility_services", "com.tokendeal.vremote_spoof/com.tokendeal.vremote.RemoteAccessibilityService");
    // Notice context pkg is com.tokendeal.vremote
    // Does com.tokendeal.vremote_spoof match?
    // Let's test if the logic correctly rejects or if it passes
    const enabled = RemoteAccessibilityServiceMock.isAccessibilityServiceEnabled(ctx);
    assert.strictEqual(enabled, false, "Must reject spoofed package prefix");
});

runTest("Adversarial parser - ACCESSIBILITY_ENABLED == 0 with service in string returns false", () => {
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 0);
    ctx.setSecureString("enabled_accessibility_services", "com.tokendeal.vremote/com.tokendeal.vremote.RemoteAccessibilityService");
    assert.strictEqual(RemoteAccessibilityServiceMock.isAccessibilityServiceEnabled(ctx), false);
});

runTest("Adversarial parser - null or empty enabled_accessibility_services returns false safely", () => {
    const ctx = new MockContext();
    ctx.setSecureInt("accessibility_enabled", 1);
    ctx.setSecureString("enabled_accessibility_services", null);
    assert.strictEqual(RemoteAccessibilityServiceMock.isAccessibilityServiceEnabled(ctx), false);

    ctx.setSecureString("enabled_accessibility_services", "   ");
    assert.strictEqual(RemoteAccessibilityServiceMock.isAccessibilityServiceEnabled(ctx), false);
});

console.log("\n=================================================================");
console.log(`TEST SUMMARY: ${passedTests} / ${totalTests} PASSED`);
if (passedTests === totalTests) {
    console.log("ALL TESTS COMPLETED SUCCESSFULLY!");
} else {
    console.error(`SOME TESTS FAILED: ${totalTests - passedTests} failures`);
    process.exit(1);
}
console.log("=================================================================\n");
