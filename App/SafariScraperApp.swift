import SwiftUI
import Photos

@main
struct SafariScraperApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    @State private var status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationView {
            List {
                Section {
                    HStack {
                        Label("Photos access", systemImage: "photo.on.rectangle")
                        Spacer()
                        Text(statusText).foregroundStyle(statusColor)
                    }
                    if status == .notDetermined {
                        Button("Allow Photos Access") {
                            PHPhotoLibrary.requestAuthorization(for: .addOnly) { s in
                                DispatchQueue.main.async { status = s }
                            }
                        }
                    } else if status == .denied || status == .restricted {
                        Button("Open Settings") { openSettings() }
                    }
                } footer: {
                    Text("The Safari extension saves straight into your library. It can only ask to add photos, never read them.")
                }

                Section("Turn on the extension") {
                    step(1, "Open **Settings → Safari → Extensions** (iOS 18+: **Settings → Apps → Safari → Extensions**).")
                    step(2, "Switch on **SafariScraper** (bulk images) and/or **CardScraper** (character cards).")
                    step(3, "Set **All Websites** to **Allow** (or approve sites one at a time).")
                    Button("Open Settings") { openSettings() }
                }

                Section("Use it") {
                    step(1, "In Safari, tap the **puzzle piece** (or **ᴀA**) in the address bar.")
                    step(2, "Tap **SafariScraper**. Every image on the page shows up in a grid.")
                    step(3, "Filter by size, tap to deselect any you don't want, then **Save to Photos**.")
                    step(4, "Use **Scroll & rescan** on pages that lazy-load images as you scroll.")
                }

                Section("CardScraper") {
                    step(1, "Open a character page and tap **CardScraper** in the extensions menu.")
                    step(2, "It grabs the main image plus Scenario, Personality, First message and Example dialogs. Edit anything that's off.")
                    step(3, "Tap **Save card PNG** → **Save to Files**. The text is embedded in the PNG (Tavern card V2), ready to import.")
                    step(4, "On a chat page, use the **Chat** tab to export the conversation as a SillyTavern **.jsonl** chat.")
                }

                Section {
                    Text("**Share…** sends the originals through the iOS share sheet. **Zip** bundles everything into one file you can save to Files. Use these if Save to Photos fails for a site that needs you to be logged in.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("SafariScraper")
        }
        .navigationViewStyle(.stack)
        .onChange(of: scenePhase) { phase in
            if phase == .active { status = PHPhotoLibrary.authorizationStatus(for: .addOnly) }
        }
    }

    private func step(_ n: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(n)").font(.callout.monospacedDigit().bold()).foregroundStyle(.tint)
            Text(text)
        }
    }

    private var statusText: String {
        switch status {
        case .authorized: return "Allowed"
        case .limited: return "Limited"
        case .denied: return "Denied"
        case .restricted: return "Restricted"
        case .notDetermined: return "Not asked"
        @unknown default: return "Unknown"
        }
    }

    private var statusColor: Color {
        switch status {
        case .authorized, .limited: return .green
        case .notDetermined: return .secondary
        default: return .red
        }
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }
}
