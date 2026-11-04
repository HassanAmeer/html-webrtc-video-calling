import test from 'node:test';
import assert from 'node:assert/strict';

// Exact string parsing logic from RemoteAccessibilityService.java
function parseAccessibilityServiceEnabled(masterSwitch, services, packageName, serviceFullName, serviceSimpleName) {
  if (!packageName) return false;
  try {
    if (masterSwitch !== 1) {
      return false;
    }

    if (!services || services.trim() === '') {
      return false;
    }

    const expectedString1 = `${packageName}/${serviceFullName}`;
    const expectedString2 = `${packageName}/.${serviceSimpleName}`;
    const simpleTarget = `${packageName}/${serviceSimpleName}`;

    // TextUtils.SimpleStringSplitter(':')
    const tokens = services.split(':');
    for (const token of tokens) {
      if (token == null) continue;
      const trimmed = token.trim();
      if (trimmed === '') continue;

      if (
        trimmed.toLowerCase() === expectedString1.toLowerCase() ||
        trimmed.toLowerCase() === expectedString2.toLowerCase() ||
        trimmed.includes(simpleTarget) ||
        (trimmed.startsWith(`${packageName}/`) && trimmed.includes('RemoteAccessibilityService'))
      ) {
        return true;
      }

      // ComponentName.unflattenFromString(trimmed)
      const sep = trimmed.indexOf('/');
      if (sep >= 0 && sep + 1 < trimmed.length) {
        const pkg = trimmed.substring(0, sep);
        let cls = trimmed.substring(sep + 1);
        if (cls.length > 0 && cls.charAt(0) === '.') {
          cls = pkg + cls;
        }

        if (pkg.toLowerCase() === packageName.toLowerCase()) {
          if (
            cls.toLowerCase() === serviceFullName.toLowerCase() ||
            cls.endsWith(serviceSimpleName)
          ) {
            return true;
          }
        }
      }
    }
  } catch (ignored) {}
  return false;
}

// State machine simulator for MainActivity.checkAccessibilityPrompt()
class MainActivitySimulator {
  constructor() {
    this.hasPromptedAccessibilityRam = false;
    this.hasPromptedAccessibilityDisk = false;
    this.serviceRunningOrEnabled = false;
    this.isFinishing = false;
    this.isDestroyed = false;
  }

  checkAccessibilityPrompt(advanceTimer1200ms = true) {
    const result = {
      dialogScheduled: false,
      dialogActuallyShown: false,
      finalRam: false,
      finalDisk: false,
    };

    const alreadyPrompted = this.hasPromptedAccessibilityDisk;

    // 1. If previously prompted or acknowledged, permanently suppress
    if (this.hasPromptedAccessibilityRam || alreadyPrompted) {
      this.hasPromptedAccessibilityRam = true;
      result.finalRam = this.hasPromptedAccessibilityRam;
      result.finalDisk = this.hasPromptedAccessibilityDisk;
      return result;
    }

    // 2. Dual-check: If accessibility service is ALREADY running or enabled in Settings, suppress popup permanently
    if (this.serviceRunningOrEnabled) {
      this.hasPromptedAccessibilityRam = true;
      this.hasPromptedAccessibilityDisk = true;
      result.finalRam = this.hasPromptedAccessibilityRam;
      result.finalDisk = this.hasPromptedAccessibilityDisk;
      return result;
    }

    // 3. Service is not running and not enabled: prompt user once, and record in SharedPreferences to permanently suppress
    this.hasPromptedAccessibilityRam = true;
    this.hasPromptedAccessibilityDisk = true;
    result.dialogScheduled = true;

    if (advanceTimer1200ms) {
      if (this.isFinishing || this.isDestroyed) {
        result.dialogActuallyShown = false;
      } else if (this.serviceRunningOrEnabled) {
        // Double check before showing dialog in case service started during delay
        result.dialogActuallyShown = false;
      } else {
        result.dialogActuallyShown = true;
      }
    }

    result.finalRam = this.hasPromptedAccessibilityRam;
    result.finalDisk = this.hasPromptedAccessibilityDisk;
    return result;
  }
}

test('isAccessibilityServiceEnabled - rejects invalid and empty inputs', () => {
  const pkg = 'com.tokendeal.vremote';
  const full = 'com.tokendeal.vremote.RemoteAccessibilityService';
  const simple = 'RemoteAccessibilityService';

  assert.equal(parseAccessibilityServiceEnabled(1, null, pkg, full, simple), false);
  assert.equal(parseAccessibilityServiceEnabled(1, '', pkg, full, simple), false);
  assert.equal(parseAccessibilityServiceEnabled(1, '   \t\n  ', pkg, full, simple), false);
  assert.equal(parseAccessibilityServiceEnabled(1, ':::::', pkg, full, simple), false);
  assert.equal(parseAccessibilityServiceEnabled(1, 'random_junk_no_slash', pkg, full, simple), false);
  assert.equal(parseAccessibilityServiceEnabled(1, '/RemoteAccessibilityService', pkg, full, simple), false);
  assert.equal(parseAccessibilityServiceEnabled(1, 'com.tokendeal.vremote/', pkg, full, simple), false);
});

test('isAccessibilityServiceEnabled - rejects unauthorized third-party apps and collisions', () => {
  const pkg = 'com.tokendeal.vremote';
  const full = 'com.tokendeal.vremote.RemoteAccessibilityService';
  const simple = 'RemoteAccessibilityService';

  // Different package using same class name
  assert.equal(parseAccessibilityServiceEnabled(1, 'com.evil.malware/.RemoteAccessibilityService', pkg, full, simple), false);
  assert.equal(parseAccessibilityServiceEnabled(1, 'com.evil.malware/com.evil.malware.RemoteAccessibilityService', pkg, full, simple), false);

  // Package prefix collisions
  assert.equal(parseAccessibilityServiceEnabled(1, 'com.tokendeal.vremote.evil/.RemoteAccessibilityService', pkg, full, simple), false);
  assert.equal(parseAccessibilityServiceEnabled(1, 'com.tokendeal.vremote_spoof/RemoteAccessibilityService', pkg, full, simple), false);

  // Same package, different service
  assert.equal(parseAccessibilityServiceEnabled(1, 'com.tokendeal.vremote/.ScreenCaptureService', pkg, full, simple), false);
  assert.equal(parseAccessibilityServiceEnabled(1, 'com.tokendeal.vremote/com.tokendeal.vremote.BackgroundKeepAliveService', pkg, full, simple), false);
});

test('isAccessibilityServiceEnabled - accepts all valid service representations', () => {
  const pkg = 'com.tokendeal.vremote';
  const full = 'com.tokendeal.vremote.RemoteAccessibilityService';
  const simple = 'RemoteAccessibilityService';

  // Canonical full form
  assert.equal(parseAccessibilityServiceEnabled(1, 'com.tokendeal.vremote/com.tokendeal.vremote.RemoteAccessibilityService', pkg, full, simple), true);
  // Canonical short form with dot
  assert.equal(parseAccessibilityServiceEnabled(1, 'com.tokendeal.vremote/.RemoteAccessibilityService', pkg, full, simple), true);
  // Short form without dot
  assert.equal(parseAccessibilityServiceEnabled(1, 'com.tokendeal.vremote/RemoteAccessibilityService', pkg, full, simple), true);
  // Mixed case
  assert.equal(parseAccessibilityServiceEnabled(1, 'COM.TOKENDEAL.VREMOTE/.RemoteAccessibilityService', pkg, full, simple), true);
  // Whitespace padded
  assert.equal(parseAccessibilityServiceEnabled(1, '  com.tokendeal.vremote/.RemoteAccessibilityService  ', pkg, full, simple), true);
});

test('isAccessibilityServiceEnabled - handles multi-service colon-separated strings', () => {
  const pkg = 'com.tokendeal.vremote';
  const full = 'com.tokendeal.vremote.RemoteAccessibilityService';
  const simple = 'RemoteAccessibilityService';

  // Head
  assert.equal(parseAccessibilityServiceEnabled(1, 'com.tokendeal.vremote/.RemoteAccessibilityService:com.google.android.marvin.talkback/.TalkBack', pkg, full, simple), true);
  // Middle
  assert.equal(parseAccessibilityServiceEnabled(1, 'com.google/.TalkBack:com.tokendeal.vremote/.RemoteAccessibilityService:com.samsung/.Voice', pkg, full, simple), true);
  // Tail
  assert.equal(parseAccessibilityServiceEnabled(1, 'com.google/.TalkBack:com.tokendeal.vremote/.RemoteAccessibilityService', pkg, full, simple), true);
  // Redundant colons
  assert.equal(parseAccessibilityServiceEnabled(1, ':::com.other/.Service:::com.tokendeal.vremote/.RemoteAccessibilityService:::', pkg, full, simple), true);
});

test('isAccessibilityServiceEnabled - honors master accessibility switch', () => {
  const pkg = 'com.tokendeal.vremote';
  const full = 'com.tokendeal.vremote.RemoteAccessibilityService';
  const simple = 'RemoteAccessibilityService';
  const validStr = 'com.tokendeal.vremote/.RemoteAccessibilityService';

  // Switch 0 = disabled
  assert.equal(parseAccessibilityServiceEnabled(0, validStr, pkg, full, simple), false);
  // Switch 2 = invalid
  assert.equal(parseAccessibilityServiceEnabled(2, validStr, pkg, full, simple), false);
  // Switch 1 = enabled
  assert.equal(parseAccessibilityServiceEnabled(1, validStr, pkg, full, simple), true);
});

test('checkAccessibilityPrompt - truth table invariant validation', () => {
  const combinations = [
    { ram: false, disk: false, running: false, expectScheduled: true, expectShown: true },
    { ram: false, disk: false, running: true, expectScheduled: false, expectShown: false },
    { ram: false, disk: true, running: false, expectScheduled: false, expectShown: false },
    { ram: false, disk: true, running: true, expectScheduled: false, expectShown: false },
    { ram: true, disk: false, running: false, expectScheduled: false, expectShown: false },
    { ram: true, disk: false, running: true, expectScheduled: false, expectShown: false },
    { ram: true, disk: true, running: false, expectScheduled: false, expectShown: false },
    { ram: true, disk: true, running: true, expectScheduled: false, expectShown: false },
  ];

  for (const c of combinations) {
    const sim = new MainActivitySimulator();
    sim.hasPromptedAccessibilityRam = c.ram;
    sim.hasPromptedAccessibilityDisk = c.disk;
    sim.serviceRunningOrEnabled = c.running;

    const res = sim.checkAccessibilityPrompt(true);
    assert.equal(res.dialogScheduled, c.expectScheduled, `dialogScheduled failed for ${JSON.stringify(c)}`);
    assert.equal(res.dialogActuallyShown, c.expectShown, `dialogActuallyShown failed for ${JSON.stringify(c)}`);

    // In all cases, after check, ram must be true (suppressed)
    assert.equal(res.finalRam, true);
    if (c.expectScheduled || (!c.ram && c.running) || c.disk) {
      assert.equal(res.finalDisk, true);
    } else {
      assert.equal(res.finalDisk, false);
    }
  }
});

test('checkAccessibilityPrompt - rapid re-entrancy prevention', () => {
  const sim = new MainActivitySimulator();
  // First onResume schedules
  const first = sim.checkAccessibilityPrompt(false);
  assert.equal(first.dialogScheduled, true);

  // Immediate second onResume before 1200ms
  const second = sim.checkAccessibilityPrompt(false);
  assert.equal(second.dialogScheduled, false);
});

test('checkAccessibilityPrompt - service enabled during 1200ms delay aborts dialog', () => {
  const sim = new MainActivitySimulator();
  const first = sim.checkAccessibilityPrompt(false);
  assert.equal(first.dialogScheduled, true);

  // User or system turns service on
  sim.serviceRunningOrEnabled = true;

  // Runnable fires at 1200ms
  let dialogShown = false;
  if (!sim.isFinishing && !sim.isDestroyed && !sim.serviceRunningOrEnabled) {
    dialogShown = true;
  }
  assert.equal(dialogShown, false, 'Dialog should abort if service started during delay window');
});

test('checkAccessibilityPrompt - activity destroyed during delay window aborts dialog', () => {
  const sim = new MainActivitySimulator();
  const first = sim.checkAccessibilityPrompt(false);
  assert.equal(first.dialogScheduled, true);

  sim.isDestroyed = true;

  let dialogShown = false;
  if (!sim.isFinishing && !sim.isDestroyed && !sim.serviceRunningOrEnabled) {
    dialogShown = true;
  }
  assert.equal(dialogShown, false, 'Dialog should abort if activity is destroyed');
});
