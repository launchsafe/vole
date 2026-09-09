import SwiftUI

/// Settings → Software Update: current version, the check, and the one-click
/// install with its live progress and its honest failure states.
struct SoftwareUpdatePane: View {
    @Bindable var checker: UpdateChecker

    private var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                LabeledContent("Installed") {
                    Text("v\(currentVersion)").monospacedDigit()
                }
                Spacer()
                switch checker.status {
                case .checking, .idle:
                    EmptyView()
                case .available(let v):
                    Text("v\(v) available").foregroundStyle(.blue)
                default:
                    EmptyView()
                }
                Button("Check Now") { checker.check(userInitiated: true) }
                    .disabled(isBusy)
            }

            switch checker.status {
            case .idle, .checking:
                EmptyView()
            case .upToDate:
                Label("Up to date", systemImage: "checkmark.circle")
                    .font(.caption).foregroundStyle(.secondary)
            case .available(let v):
                HStack {
                    Button("Install v\(v)") { checker.installOrUpdate() }
                        .buttonStyle(.borderedProminent)
                    Text("Downloads, verifies the published checksum, replaces this app, and relaunches.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            case .downloading(let v):
                VStack(alignment: .leading, spacing: 4) {
                    Text("Downloading v\(v)…").font(.caption)
                    ProgressView(value: checker.progress)
                        .frame(maxWidth: 260)
                }
            case .verifying:
                Label("Verifying checksum…", systemImage: "checkmark.shield")
                    .font(.caption).foregroundStyle(.secondary)
            case .installing:
                Label("Installing — the app will relaunch", systemImage: "arrow.triangle.2.circlepath")
                    .font(.caption).foregroundStyle(.secondary)
            case .failed(let reason):
                Label(reason, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .padding(.vertical, 2)
    }

    private var isBusy: Bool {
        switch checker.status {
        case .checking, .downloading, .verifying, .installing: true
        default: false
        }
    }
}
