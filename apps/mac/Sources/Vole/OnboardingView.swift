import SwiftUI
import AppKit
import UserNotifications

/// First-launch-only: Get Started → Permissions → the dashboard opens and this
/// window closes. Every later launch skips straight past this (see
/// VoleApp.openOnboardingAtLaunch) — the menu-bar-only default, or --dashboard.
struct OnboardingView: View {
    let store: Store
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismiss) private var dismiss
    @State private var step: Step = .welcome
    /// The real authorization status, not just granted/not. macOS shows its prompt
    /// exactly ONCE: after a denial, requestAuthorization returns immediately with
    /// granted=false and no dialog, so an "Enable" button that calls it is a dead
    /// control. Denied has to route to System Settings instead.
    @State private var notifStatus: UNAuthorizationStatus?

    enum Step { case welcome, permissions }

    var body: some View {
        Group {
            switch step {
            case .welcome:     welcome
            case .permissions: permissions
            }
        }
        .padding(40)
        .frame(width: 420, height: 520)
        .task { await refreshNotificationStatus() }
        // Coming back from System Settings must update the row. The task above runs
        // once on appear, so without this the user flips the switch, returns, and the
        // screen still tells them it is off.
        .onReceive(NotificationCenter.default.publisher(
            for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await refreshNotificationStatus() }
        }
    }

    private var welcome: some View {
        VStack(spacing: 16) {
            if let mark = Res.image("MenuBarGlyph") {
                Image(nsImage: mark).renderingMode(.template)
                    .resizable().scaledToFit()
                    .frame(height: 40)
                    .foregroundStyle(.primary)
            }
            Button("Get Started") { step = .permissions }
                .buttonStyle(.glass).controlSize(.large).tint(.black)
                .padding(.top, 64)
                .keyboardShortcut(.defaultAction)
        }
    }

    private var permissions: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Permissions").font(.title.weight(.semibold))
            // Vole asks for nothing else. Every source it reads is a dotfile in your
            // own home (~/.claude, ~/.codex, ~/.grok, ~/.local/share/opencode) or
            // ~/Library/Application Support — none of it behind macOS's privacy
            // protection, so Full Disk Access is not required and is not requested.
            Text("Optional — Vole reads your agents' local logs and needs no special access for that.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            permissionRow(
                title: "Notifications",
                detail: notifStatus == .denied
                    ? "Currently turned off for Vole. macOS only asks once, so this has to be switched back on in System Settings."
                    : "Get an alert the moment a critical incident fires, instead of finding it on your next check-in.",
                granted: notifStatus == .authorized,
                actionLabel: notifStatus == .denied ? "Open Settings" : "Enable",
                action: notifStatus == .denied ? openNotificationSettings : requestNotifications)

            HStack {
                Spacer()
                Button("Continue") { finish() }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .keyboardShortcut(.defaultAction)
            }
        }
    }

    @ViewBuilder
    private func permissionRow(title: String, detail: String, granted: Bool?,
                                actionLabel: String, action: @escaping () -> Void) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: granted == true ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(granted == true ? Color.green : Color.secondary)
                .font(.title3)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(detail).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if granted != true {
                Button(actionLabel, action: action).font(.caption).buttonStyle(.bordered)
            }
        }
    }

    private func requestNotifications() {
        guard Bundle.main.bundleIdentifier != nil else { return }   // see VoleApp.init
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in
            // Re-read rather than trust the callback's Bool: it reports false both for
            // "the user just declined" and for "already denied, no prompt shown", and
            // the row needs to tell those apart to offer the right next step.
            Task { await refreshNotificationStatus() }
        }
    }

    private func openNotificationSettings() {
        NSWorkspace.shared.open(
            URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!)
    }

    private func refreshNotificationStatus() async {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        await MainActor.run { notifStatus = settings.authorizationStatus }
    }

    private func finish() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: "dashboard")
        dismiss()
    }
}
