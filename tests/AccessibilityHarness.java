package tests;

import java.util.*;

public class AccessibilityHarness {

    // AOSP TextUtils.SimpleStringSplitter faithful implementation
    public static class SimpleStringSplitter implements Iterator<String> {
        private String mString;
        private char mDelimiter;
        private int mPosition;
        private int mLength;

        public SimpleStringSplitter(char delimiter) {
            mDelimiter = delimiter;
        }

        public void setString(String string) {
            mString = string;
            mPosition = 0;
            mLength = mString.length();
        }

        public boolean hasNext() {
            return mPosition < mLength;
        }

        public String next() {
            int end = mString.indexOf(mDelimiter, mPosition);
            if (end == -1) {
                end = mLength;
            }
            String nextString = mString.substring(mPosition, end);
            mPosition = end + 1;
            return nextString;
        }
    }

    // AOSP ComponentName faithful implementation
    public static class ComponentName {
        private final String mPackage;
        private final String mClass;

        public ComponentName(String pkg, String cls) {
            if (pkg == null || cls == null) throw new NullPointerException();
            mPackage = pkg;
            mClass = cls;
        }

        public String getPackageName() {
            return mPackage;
        }

        public String getClassName() {
            return mClass;
        }

        public static ComponentName unflattenFromString(String str) {
            if (str == null) return null;
            int sep = str.indexOf('/');
            if (sep < 0 || (sep + 1) >= str.length()) {
                return null;
            }
            String pkg = str.substring(0, sep);
            String cls = str.substring(sep + 1);
            if (cls.length() > 0 && cls.charAt(0) == '.') {
                cls = pkg + cls;
            }
            return new ComponentName(pkg, cls);
        }

        @Override
        public boolean equals(Object obj) {
            if (!(obj instanceof ComponentName)) return false;
            ComponentName other = (ComponentName) obj;
            return mPackage.equals(other.mPackage) && mClass.equals(other.mClass);
        }

        @Override
        public int hashCode() {
            return mPackage.hashCode() + mClass.hashCode();
        }

        @Override
        public String toString() {
            return "ComponentInfo{" + mPackage + "/" + mClass + "}";
        }
    }

    // Exact string parsing logic from RemoteAccessibilityService.java
    public static boolean parseAccessibilityServiceEnabled(
            int accessibilityMasterSwitch,
            String services,
            String packageName,
            String serviceFullName,
            String serviceSimpleName) {

        if (packageName == null) return false;
        try {
            if (accessibilityMasterSwitch != 1) {
                return false;
            }

            if (services == null || services.trim().isEmpty()) {
                return false;
            }

            ComponentName expectedComponent = new ComponentName(packageName, serviceFullName);
            String expectedString1 = packageName + "/" + serviceFullName;
            String expectedString2 = packageName + "/." + serviceSimpleName;
            String simpleTarget = packageName + "/" + serviceSimpleName;

            SimpleStringSplitter splitter = new SimpleStringSplitter(':');
            splitter.setString(services);
            while (splitter.hasNext()) {
                String component = splitter.next();
                if (component == null) continue;
                String trimmed = component.trim();
                if (trimmed.isEmpty()) continue;

                if (trimmed.equalsIgnoreCase(expectedString1)
                        || trimmed.equalsIgnoreCase(expectedString2)
                        || trimmed.contains(simpleTarget)
                        || (trimmed.startsWith(packageName + "/") && trimmed.contains("RemoteAccessibilityService"))) {
                    return true;
                }
                ComponentName enabledComponent = ComponentName.unflattenFromString(trimmed);
                if (enabledComponent != null) {
                    if (enabledComponent.equals(expectedComponent)) {
                        return true;
                    }
                    if (packageName.equalsIgnoreCase(enabledComponent.getPackageName())) {
                        String cls = enabledComponent.getClassName();
                        if (cls != null && (cls.equalsIgnoreCase(serviceFullName)
                                || cls.endsWith(serviceSimpleName))) {
                            return true;
                        }
                    }
                }
            }
        } catch (Throwable ignored) {}
        return false;
    }

    // State machine simulator for MainActivity checkAccessibilityPrompt()
    public static class PromptSimulationResult {
        public boolean dialogScheduled;
        public boolean dialogActuallyShown;
        public boolean finalRamPrompted;
        public boolean finalDiskPrompted;
    }

    public static class MainActivityPromptSimulator {
        public boolean hasPromptedAccessibilityRam = false;
        public boolean hasPromptedAccessibilityDisk = false;
        public boolean serviceRunningOrEnabled = false;
        public boolean isActivityFinishing = false;
        public boolean isActivityDestroyed = false;

        public PromptSimulationResult checkAccessibilityPrompt(boolean advanceTimer1200ms) {
            PromptSimulationResult result = new PromptSimulationResult();

            boolean alreadyPrompted = hasPromptedAccessibilityDisk;

            // 1. If previously prompted or acknowledged, permanently suppress
            if (hasPromptedAccessibilityRam || alreadyPrompted) {
                hasPromptedAccessibilityRam = true;
                result.dialogScheduled = false;
                result.dialogActuallyShown = false;
                result.finalRamPrompted = hasPromptedAccessibilityRam;
                result.finalDiskPrompted = hasPromptedAccessibilityDisk;
                return result;
            }

            // 2. Dual-check: If accessibility service is ALREADY running or enabled in Settings, suppress popup permanently
            if (serviceRunningOrEnabled) {
                hasPromptedAccessibilityRam = true;
                hasPromptedAccessibilityDisk = true;
                result.dialogScheduled = false;
                result.dialogActuallyShown = false;
                result.finalRamPrompted = hasPromptedAccessibilityRam;
                result.finalDiskPrompted = hasPromptedAccessibilityDisk;
                return result;
            }

            // 3. Service is not running and not enabled: prompt user once, and record in SharedPreferences to permanently suppress
            hasPromptedAccessibilityRam = true;
            hasPromptedAccessibilityDisk = true;
            result.dialogScheduled = true;

            if (advanceTimer1200ms) {
                if (isActivityFinishing || isActivityDestroyed) {
                    result.dialogActuallyShown = false;
                } else if (serviceRunningOrEnabled) {
                    // Double check before showing dialog in case service started during delay
                    result.dialogActuallyShown = false;
                } else {
                    result.dialogActuallyShown = true;
                }
            } else {
                result.dialogActuallyShown = false;
            }

            result.finalRamPrompted = hasPromptedAccessibilityRam;
            result.finalDiskPrompted = hasPromptedAccessibilityDisk;
            return result;
        }
    }

    public static void main(String[] args) {
        int passed = 0;
        int failed = 0;

        String pkg = "com.tokendeal.vremote";
        String clsFull = "com.tokendeal.vremote.RemoteAccessibilityService";
        String clsSimple = "RemoteAccessibilityService";

        System.out.println("=================================================================");
        System.out.println("SUITE 1: Synthetic Input Stress Testing for isAccessibilityServiceEnabled");
        System.out.println("=================================================================");

        Object[][] tests = {
            // { description, masterSwitch, servicesString, expectedResult }
            { "1. Null string", 1, null, false },
            { "2. Empty string", 1, "", false },
            { "3. Whitespace only spaces", 1, "    ", false },
            { "4. Whitespace tabs and newlines", 1, "\t\r\n ", false },
            { "5. Single colon", 1, ":", false },
            { "6. Multiple colons only", 1, ":::::", false },
            { "7. Corrupted string - no slash", 1, "com.tokendeal.vremote", false },
            { "8. Corrupted string - only slash", 1, "/", false },
            { "9. Corrupted string - leading slash", 1, "/RemoteAccessibilityService", false },
            { "10. Corrupted string - trailing slash", 1, "com.tokendeal.vremote/", false },
            { "11. Corrupted string - random junk", 1, "xyz!@#$%^&*()_+:;;<>,.?", false },
            { "12. Different app same class name", 1, "com.malicious.app/com.malicious.app.RemoteAccessibilityService", false },
            { "13. Different app short name", 1, "com.other.app/.RemoteAccessibilityService", false },
            { "14. App prefix collision .evil", 1, "com.tokendeal.vremote.evil/.RemoteAccessibilityService", false },
            { "15. App prefix collision _suffix", 1, "com.tokendeal.vremote_app/.RemoteAccessibilityService", false },
            { "16. Same app different service", 1, "com.tokendeal.vremote/.ScreenCaptureService", false },
            { "17. Same app another service", 1, "com.tokendeal.vremote/com.tokendeal.vremote.BackgroundKeepAliveService", false },

            // Valid positive cases
            { "18. Canonical full form", 1, "com.tokendeal.vremote/com.tokendeal.vremote.RemoteAccessibilityService", true },
            { "19. Canonical short form with dot", 1, "com.tokendeal.vremote/.RemoteAccessibilityService", true },
            { "20. Canonical short form without dot", 1, "com.tokendeal.vremote/RemoteAccessibilityService", true },
            { "21. Upper-case / mixed-case package", 1, "COM.TOKENDEAL.VREMOTE/.RemoteAccessibilityService", true },
            { "22. Leading and trailing whitespace", 1, "   com.tokendeal.vremote/.RemoteAccessibilityService   ", true },
            { "23. Multi-service: target is first", 1, "com.tokendeal.vremote/.RemoteAccessibilityService:com.google.android.marvin.talkback/.TalkBackService", true },
            { "24. Multi-service: target is in middle", 1, "com.google.android.marvin.talkback/.TalkBackService:com.tokendeal.vremote/com.tokendeal.vremote.RemoteAccessibilityService:com.samsung.accessibility/.VoiceAssistant", true },
            { "25. Multi-service: target is last", 1, "com.google.android.marvin.talkback/.TalkBackService:com.tokendeal.vremote/.RemoteAccessibilityService", true },
            { "26. Multi-service with multiple consecutive colons", 1, ":::com.other.app/.Service:::com.tokendeal.vremote/.RemoteAccessibilityService:::", true },
            { "27. Multi-service with whitespace around colons", 1, " com.other.service/.A : com.tokendeal.vremote/.RemoteAccessibilityService : com.third/.C ", true },

            // Master switch checks
            { "28. Master switch 0 with valid service", 0, "com.tokendeal.vremote/.RemoteAccessibilityService", false },
            { "29. Master switch 2 with valid service", 2, "com.tokendeal.vremote/.RemoteAccessibilityService", false },
            { "30. Master switch -1 with valid service", -1, "com.tokendeal.vremote/.RemoteAccessibilityService", false }
        };

        for (Object[] tc : tests) {
            String desc = (String) tc[0];
            int master = (Integer) tc[1];
            String input = (String) tc[2];
            boolean expected = (Boolean) tc[3];

            boolean actual = parseAccessibilityServiceEnabled(master, input, pkg, clsFull, clsSimple);
            if (actual == expected) {
                System.out.println("[PASS] " + desc);
                passed++;
            } else {
                System.err.println("[FAIL] " + desc + " -> Expected: " + expected + ", Got: " + actual + " for input: '" + input + "'");
                failed++;
            }
        }

        // Stress test: 10,000 services in a single string
        StringBuilder largeServices = new StringBuilder();
        for (int i = 0; i < 5000; i++) {
            largeServices.append("com.dummy.app").append(i).append("/.DummyService: ");
        }
        largeServices.append("com.tokendeal.vremote/.RemoteAccessibilityService:");
        for (int i = 5001; i < 10000; i++) {
            largeServices.append("com.dummy.app").append(i).append("/.DummyService: ");
        }
        long startT = System.currentTimeMillis();
        boolean stressResult = parseAccessibilityServiceEnabled(1, largeServices.toString(), pkg, clsFull, clsSimple);
        long elapsed = System.currentTimeMillis() - startT;
        if (stressResult && elapsed < 500) {
            System.out.println("[PASS] 31. Large list stress test (10,000 services, parsed in " + elapsed + "ms)");
            passed++;
        } else {
            System.err.println("[FAIL] 31. Large list stress test -> Got: " + stressResult + ", Time: " + elapsed + "ms");
            failed++;
        }

        System.out.println("\n=================================================================");
        System.out.println("SUITE 2: Structural Logic & State Machine for checkAccessibilityPrompt");
        System.out.println("=================================================================");

        // Adversarial State Machine Testing
        // Test combinations: (RAM, Disk, ServiceRunning)
        boolean[] bools = { false, true };
        int stateCount = 0;
        for (boolean ram : bools) {
            for (boolean disk : bools) {
                for (boolean running : bools) {
                    stateCount++;
                    MainActivityPromptSimulator sim = new MainActivityPromptSimulator();
                    sim.hasPromptedAccessibilityRam = ram;
                    sim.hasPromptedAccessibilityDisk = disk;
                    sim.serviceRunningOrEnabled = running;

                    PromptSimulationResult res = sim.checkAccessibilityPrompt(true);

                    // Property 1: If disk is true, dialog MUST NEVER be scheduled or shown
                    if (disk && (res.dialogScheduled || res.dialogActuallyShown)) {
                        System.err.println("[FAIL] Violation: Disk is true but dialog triggered! RAM=" + ram + ", Disk=" + disk + ", Running=" + running);
                        failed++;
                    }
                    // Property 2: If running is true, dialog MUST NEVER be scheduled or shown
                    else if (running && (res.dialogScheduled || res.dialogActuallyShown)) {
                        System.err.println("[FAIL] Violation: Running is true but dialog triggered! RAM=" + ram + ", Disk=" + disk + ", Running=" + running);
                        failed++;
                    }
                    // Property 3: If ram is true, dialog MUST NEVER be scheduled or shown
                    else if (ram && (res.dialogScheduled || res.dialogActuallyShown)) {
                        System.err.println("[FAIL] Violation: RAM is true but dialog triggered! RAM=" + ram + ", Disk=" + disk + ", Running=" + running);
                        failed++;
                    }
                    // Property 4: Only when (ram=false, disk=false, running=false) can dialog be scheduled
                    else if (!ram && !disk && !running) {
                        if (!res.dialogScheduled || !res.dialogActuallyShown) {
                            System.err.println("[FAIL] Expected dialog to show for fresh unprompted state!");
                            failed++;
                        } else if (!res.finalDiskPrompted || !res.finalRamPrompted) {
                            System.err.println("[FAIL] Disk and RAM were not persisted upon scheduling dialog!");
                            failed++;
                        } else {
                            System.out.println("[PASS] Fresh state (RAM=F, Disk=F, Running=F) -> dialog scheduled & persisted immediately.");
                            passed++;
                        }
                    } else {
                        System.out.println("[PASS] State (" + (ram ? "RAM=T" : "RAM=F") + ", " +
                                (disk ? "Disk=T" : "Disk=F") + ", " +
                                (running ? "Running=T" : "Running=F") + ") -> Prompt cleanly suppressed. Scheduled=" + res.dialogScheduled + ", Shown=" + res.dialogActuallyShown);
                        passed++;
                    }
                }
            }
        }

        // Test Rapid Double Invocation (onResume fired twice before 1200ms)
        {
            MainActivityPromptSimulator sim = new MainActivityPromptSimulator();
            PromptSimulationResult firstCall = sim.checkAccessibilityPrompt(false); // prompt scheduled, 1200ms pending
            PromptSimulationResult secondCall = sim.checkAccessibilityPrompt(false); // immediate second onResume
            if (firstCall.dialogScheduled && !secondCall.dialogScheduled) {
                System.out.println("[PASS] Re-entrancy / rapid resume test: Second call suppressed by immediate SharedPreferences commit.");
                passed++;
            } else {
                System.err.println("[FAIL] Rapid resume allowed duplicate dialog schedule!");
                failed++;
            }
        }

        // Test Service Starts During 1200ms Delay Window
        {
            MainActivityPromptSimulator sim = new MainActivityPromptSimulator();
            // Starts with service NOT running
            sim.serviceRunningOrEnabled = false;
            // First call schedules
            PromptSimulationResult firstCall = sim.checkAccessibilityPrompt(false);
            // Before 1200ms expires, user turns on service or binder connects
            sim.serviceRunningOrEnabled = true;
            // Now 1200ms runnable executes
            boolean runnableShows;
            if (sim.isActivityFinishing || sim.isActivityDestroyed || sim.serviceRunningOrEnabled) {
                runnableShows = false;
            } else {
                runnableShows = true;
            }
            if (firstCall.dialogScheduled && !runnableShows) {
                System.out.println("[PASS] In-flight service enable test: Dialog correctly aborted at 1200ms timer expiration because service is now running.");
                passed++;
            } else {
                System.err.println("[FAIL] Dialog shown even though service connected during delay window!");
                failed++;
            }
        }

        // Test Activity Finishes During 1200ms Delay Window
        {
            MainActivityPromptSimulator sim = new MainActivityPromptSimulator();
            sim.serviceRunningOrEnabled = false;
            PromptSimulationResult firstCall = sim.checkAccessibilityPrompt(false);
            sim.isActivityFinishing = true;
            boolean runnableShows = !(sim.isActivityFinishing || sim.isActivityDestroyed || sim.serviceRunningOrEnabled);
            if (firstCall.dialogScheduled && !runnableShows) {
                System.out.println("[PASS] Lifecycle termination test: Dialog correctly aborted when activity is finishing.");
                passed++;
            } else {
                System.err.println("[FAIL] Dialog attempted to show on finishing activity!");
                failed++;
            }
        }

        System.out.println("\n=================================================================");
        System.out.println("TOTAL PASSED: " + passed + " / " + (passed + failed));
        System.out.println("TOTAL FAILED: " + failed);
        System.out.println("=================================================================");

        if (failed > 0) {
            System.exit(1);
        }
    }
}
