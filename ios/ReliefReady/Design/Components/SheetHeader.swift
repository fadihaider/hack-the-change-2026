import SwiftUI

/// the title row of a bottom sheet editor, with a 44 pt close button (Sheet and SheetTitle in ui.tsx)
struct SheetHeader: View {
    var title: String
    var closeLabel = "Close"
    var onClose: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(title)
                .font(.rrTitle)
                .foregroundStyle(Theme.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
                .accessibilityAddTraits(.isHeader)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                    .frame(width: 44, height: 44)
                    .background(Theme.page, in: .rect(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(closeLabel)
        }
        .padding(.bottom, 20)
    }
}

extension View {
    /// the shared look of a bottom sheet: white, 20 pt corners, a grabber
    func rrSheet() -> some View {
        presentationCornerRadius(Theme.radiusLarge)
            .presentationDragIndicator(.visible)
            .presentationBackground(Theme.surface)
    }
}

#Preview {
    Text("Sheet body")
        .sheet(isPresented: .constant(true)) {
            VStack {
                SheetHeader(title: "Edit the message") {}
                Spacer()
            }
            .padding(Theme.gutter)
            .rrSheet()
            .presentationDetents([.medium, .large])
        }
}
