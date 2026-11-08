import SwiftUI

#if DEBUG
    /// debug only: Near Rosa on a screen of its own, so the section can be checked and screenshotted before Care
    /// embeds it. reached from Care access with the launch argument -AccessHarness nearby
    struct NearbyHarnessView: View {
        var body: some View {
            ScreenColumn {
                NearbySection()
            }
            .screenTitle("Near Rosa")
            .accessibilityIdentifier("screen.nearbyHarness")
        }

        /// true when the app was launched with -AccessHarness nearby
        static var isEnabled: Bool {
            UserDefaults.standard.string(forKey: "AccessHarness") == "nearby"
        }
    }
#endif
