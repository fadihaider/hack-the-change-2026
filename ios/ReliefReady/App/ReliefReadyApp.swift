import SwiftUI

@main
struct ReliefReadyApp: App {
    @State private var model: AppModel

    init() {
        Fonts.registerIfNeeded()
        Self.styleNavigationBars()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.light)
                .tint(Theme.teal)
                .foregroundStyle(Theme.ink)
                .font(.rrBody)
        }
    }

    /// figtree in navigation titles
    private static func styleNavigationBars() {
        guard Fonts.isFigtreeAvailable else { return }
        let appearance = UINavigationBar.appearance()
        if let large = UIFont(name: "Figtree-SemiBold", size: 34) {
            appearance.largeTitleTextAttributes = [.font: UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: large)]
        }
        if let inline = UIFont(name: "Figtree-SemiBold", size: 17) {
            appearance.titleTextAttributes = [.font: UIFontMetrics(forTextStyle: .headline).scaledFont(for: inline)]
        }
    }
}
