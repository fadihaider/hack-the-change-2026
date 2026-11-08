import SwiftUI

/// one day of the care timeline: the date stepper, the loaded day and marking done (TodayCare.tsx)
@Observable
final class TodayModel {
    private(set) var date: String = ""
    private(set) var day: CareTimeline?
    private(set) var isLoading = false
    private(set) var error: String?
    private(set) var busyKey: String?
    private(set) var itemError: (key: String, message: String)?
    var showFull = false
    /// once a day is picked, a moving demo clock no longer changes it
    private(set) var picked = false
    @ObservationIgnored private var seq = 0
    /// days already seen stay on screen while they refresh
    @ObservationIgnored private var seen: [String: CareTimeline] = [:]

    /// keeps the date on today (inside the week) until the caregiver picks a day
    func sync(today: String, start: String, end: String) {
        let todayInWeek = CareData.clampDate(today, start: start, end: end)
        if !picked || date.isEmpty { date = todayInWeek } else { date = CareData.clampDate(date, start: start, end: end) }
    }

    /// moves by days inside the week; false at the edges
    @discardableResult
    func move(_ days: Int, start: String, end: String) -> Bool {
        guard let next = AlbertaTime.addDays(date, days).map({ CareData.clampDate($0, start: start, end: end) }), next != date
        else { return false }
        picked = true
        showFull = false
        itemError = nil
        date = next
        return true
    }

    func load(_ api: APIClient) async -> CareTimeline? {
        seq += 1
        let mine = seq
        let target = date
        isLoading = true
        if let cached = seen[target] { day = cached }
        defer { if mine == seq { isLoading = false } }
        do {
            let next = try await api.timeline(date: target)
            guard mine == seq else { return nil }
            seen[target] = next
            day = next
            error = nil
            return next
        } catch {
            if mine == seq, !error.isCancelled { self.error = error.userMessage }
            return nil
        }
    }

    func mark(_ item: TimelineItem, done: Bool, api: APIClient) async -> String? {
        guard busyKey == nil, let current = day else { return nil }
        let key = TodayData.key(item)
        let on = current.date
        busyKey = key
        itemError = nil
        defer { busyKey = nil }
        do {
            let result = try await api.completeEvent(id: item.eventId, date: on, done: done)
            func update(_ view: CareTimeline) -> CareTimeline {
                var copy = view
                copy.items = TodayData.withCompletion(view.items, eventId: result.eventId, completedAt: result.completedAt)
                copy.reminders = TodayData.withCompletion(view.reminders, eventId: result.eventId, completedAt: result.completedAt)
                return copy
            }
            if let cached = seen[on] { seen[on] = update(cached) }
            if let shown = day, shown.date == on { day = update(shown) }
            return result.completedAt != nil ? "Marked done: \(item.title). Recorded by you." : "Marked not done: \(item.title)."
        } catch {
            itemError = (key, error.userMessage)
            return nil
        }
    }
}

struct TodayCareView: View {
    @Environment(AppModel.self) private var app
    var name: String
    var session: Session
    var episode: EpisodeSummary
    /// changes after each profile reload
    var version: Int
    /// the empty day offers to tell reliefready about the person; nil when the page already shows that
    var onVoice: (() -> Void)?
    var onNote: (() -> Void)?
    @State private var model = TodayModel()
    @State private var speakNext = false

    var body: some View {
        let isToday = model.date == session.today
        CareSection(
            title: isToday || model.date.isEmpty
                ? "Today\u{2019}s care"
                : "\(Labels.possessive(name)) care, \(AlbertaTime.dayLabel(model.date, short: true))",
            hint: "Approved times and appointments, in Alberta time.",
            identifier: "care.today"
        ) {
            dayNav(isToday: isToday)
            if let error = model.error {
                ErrorNote(error) { Task { _ = await model.load(app.api) } }
            }
            content(isToday: isToday)
        }
        .task(id: "\(model.date)|\(version)|\(session.appNow)") {
            guard !model.date.isEmpty else { return }
            let loaded = await model.load(app.api)
            if speakNext, let loaded {
                speakNext = false
                careAnnounce(
                    loaded.items.isEmpty
                        ? "\(AlbertaTime.dayLabel(loaded.date)): nothing planned yet."
                        : "\(AlbertaTime.dayLabel(loaded.date)): \(CareData.plural(loaded.items.count, "thing", "things")) on \(Labels.possessive(name)) day."
                )
            }
        }
        .onAppear { model.sync(today: session.today, start: episode.startsOn, end: episode.endsOn) }
        .onChange(of: "\(session.today)|\(episode.startsOn)|\(episode.endsOn)") { _, _ in
            model.sync(today: session.today, start: episode.startsOn, end: episode.endsOn)
        }
    }

    private func dayNav(isToday: Bool) -> some View {
        let atStart = model.date <= episode.startsOn
        let atEnd = model.date >= episode.endsOn
        let previous = AlbertaTime.addDays(model.date, -1) ?? model.date
        let following = AlbertaTime.addDays(model.date, 1) ?? model.date
        return HStack(spacing: 12) {
            stepButton(
                systemImage: "chevron.left", disabled: atStart,
                label: atStart ? "No earlier day in the care week" : "Previous day, \(AlbertaTime.dayLabel(previous))",
                identifier: "care.today.previous"
            ) { move(-1) }
            VStack(spacing: 2) {
                Text(AlbertaTime.dayLabel(model.date))
                    .font(.rrBodyMedium)
                    .foregroundStyle(Theme.ink)
                    .multilineTextAlignment(.center)
                if isToday {
                    TonePill("Today", tone: .ask)
                }
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("care.today.day")
            stepButton(
                systemImage: "chevron.right", disabled: atEnd,
                label: atEnd ? "No later day in the care week" : "Next day, \(AlbertaTime.dayLabel(following))",
                identifier: "care.today.next"
            ) { move(1) }
        }
        .padding(.vertical, 4)
    }

    private func stepButton(
        systemImage: String, disabled: Bool, label: String, identifier: String, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(disabled ? Theme.muted.opacity(0.5) : Theme.ink)
                .frame(width: 52, height: 52)
                .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
                .overlay { RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.hairline, lineWidth: 1) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    private func move(_ days: Int) {
        if model.move(days, start: episode.startsOn, end: episode.endsOn) { speakNext = true }
    }

    @ViewBuilder private func content(isToday: Bool) -> some View {
        if let shown = model.day {
            let stale = model.isLoading || shown.date != model.date
            let now = isToday ? AlbertaTime.parse(shown.appNow) : nil
            let preview = TodayData.preview(shown.items, now: now)
            let listed = model.showFull ? TodayData.chronological(shown.items) : preview.shown
            if shown.items.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Nothing on \(Labels.possessive(name)) day yet.").font(.rrBody).foregroundStyle(Theme.ink)
                    if let onVoice, let onNote {
                        TellAboutView(name: name, onVoice: onVoice, onNote: onNote)
                    } else {
                        Text("Times from notes you\u{2019}ve checked show up here.").font(.rrNote).foregroundStyle(Theme.muted)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .careBox(Theme.radius)
                .opacity(stale ? 0.6 : 1)
                .accessibilityIdentifier("care.today.empty")
            } else {
                Text(TodayData.overviewLine(TodayData.summary(shown.items, now: now)))
                    .font(.rrBody)
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("care.today.overview")
                VStack(spacing: 0) {
                    ForEach(listed, id: \.careKey) { item in
                        DayItemRow(
                            item: item,
                            busy: model.busyKey == TodayData.key(item),
                            locked: model.busyKey != nil && model.busyKey != TodayData.key(item),
                            error: model.itemError?.key == TodayData.key(item) ? model.itemError?.message : nil
                        ) { done in
                            Task {
                                if let said = await model.mark(item, done: done, api: app.api) { careAnnounce(said) }
                            }
                        }
                        if item.careKey != listed.last?.careKey {
                            Rectangle().fill(Theme.hairline).frame(height: 1)
                        }
                    }
                }
                .opacity(stale ? 0.6 : 1)
                if preview.hidden > 0 || model.showFull {
                    Button(model.showFull ? "Show what matters now" : "Open full day (\(preview.hidden) more)") {
                        model.showFull.toggle()
                        careAnnounce(
                            model.showFull
                                ? "Showing the full day, \(CareData.plural(preview.hidden, "more thing", "more things"))."
                                : "Showing what matters now."
                        )
                    }
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("care.today.fullDay")
                }
            }
        } else if model.error == nil {
            Text("Loading \(Labels.possessive(name)) day").font(.rrBody).foregroundStyle(Theme.muted)
        }
    }
}

private struct DayItemRow: View {
    @Environment(AppModel.self) private var app
    var item: TimelineItem
    var busy: Bool
    var locked: Bool
    var error: String?
    var onMark: (Bool) -> Void
    @State private var expanded = false

    var body: some View {
        let status = TodayData.status(item)
        let appointment = item.factId == nil
        HStack(alignment: .top, spacing: 12) {
            Text(AlbertaTime.format(item.startsAt, style: .time))
                .font(Fonts.figtree(15, weight: .semibold, relativeTo: .subheadline).monospacedDigit())
                .foregroundStyle(Theme.ink)
                .frame(minWidth: 76, alignment: .leading)
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 8) {
                    Text(TodayData.itemText(item))
                        .font(.rrBodyMedium)
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                statusPill(status)
                meta(appointment: appointment)
                Button {
                    expanded.toggle()
                } label: {
                    HStack(spacing: 6) {
                        Text(appointment ? "Full details" : "Exact approved wording")
                        CareChevron(isOpen: expanded)
                    }
                    .font(Fonts.figtree(15, weight: .semibold, relativeTo: .subheadline))
                    .foregroundStyle(Theme.tealInk)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(appointment ? "Full details" : "Exact approved wording"), \(item.title)")
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("care.today.details.\(item.title)")
                if expanded {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(appointment ? "Appointment" : CareData.categoryTitle(item.category))
                            .font(.rrLabel).foregroundStyle(Theme.muted)
                        Text(item.fullText.map { "\u{201C}\($0)\u{201D}" } ?? item.title)
                            .font(.rrBody).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                        if appointment {
                            Button { app.showUrgent() } label: {
                                Text("See it in Urgent")
                                    .font(.rrNote)
                                    .underline()
                                    .foregroundStyle(Theme.tealInk)
                                    .frame(minHeight: 44, alignment: .leading)
                                    .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(.isLink)
                            .accessibilityIdentifier("care.today.urgent.\(item.title)")
                        }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .careBox(Theme.radiusSmall)
                }
                Button {
                    if !locked { onMark(status != .done) }
                } label: {
                    Text(status == .done ? "Undo" : "Mark done")
                }
                .buttonStyle(.secondary(busy: busy))
                .disabled(busy)
                .accessibilityLabel("\(status == .done ? "Undo" : "Mark done"): \(item.title)")
                .accessibilityIdentifier("care.today.mark.\(item.title)")
                if let error { ErrorNote(error) }
            }
        }
        .padding(.vertical, 14)
        .padding(.horizontal, status == .reminder ? 12 : 0)
        .background(status == .reminder ? Theme.tealTint : .clear, in: .rect(cornerRadius: Theme.radius))
        .accessibilityElement(children: .contain)
    }

    private func statusPill(_ status: DayItemStatus) -> some View {
        let tone: StateTone = status == .done ? .good : status == .reminder ? .ask : .plain
        return HStack(spacing: 4) {
            if status == .done { Image(systemName: "checkmark").accessibilityHidden(true) }
            if status == .reminder { Image(systemName: "bell.badge").accessibilityHidden(true) }
            Text(status.label)
        }
        .font(.rrPill)
        .foregroundStyle(Theme.colors(for: tone).ink)
        .padding(.horizontal, 10)
        .frame(minHeight: 26)
        .background(tone == .plain ? Theme.surface : Theme.colors(for: tone).tint, in: .capsule)
        .overlay { if tone == .plain { Capsule().strokeBorder(Theme.hairline, lineWidth: 1) } }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Status: \(status.label)")
    }

    @ViewBuilder private func meta(appointment: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let remind = TodayData.reminderAt(item) {
                CareMetaLine(systemImage: "bell", text: "Reminder \(AlbertaTime.format(remind, style: .time))")
            }
            if let rrule = item.rrule { CareMetaLine(systemImage: "repeat", text: Labels.rrule(rrule)) }
            if appointment { CareMetaLine(systemImage: "calendar.badge.clock", text: "Appointment from Urgent") }
            if let location = item.locationText { CareMetaLine(systemImage: "mappin.and.ellipse", text: location) }
        }
    }
}

/// the one way in when nothing is written down yet (TellAbout.tsx)
struct TellAboutView: View {
    var name: String
    var onVoice: () -> Void
    var onNote: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Tell ReliefReady about \(name)").font(.rrLabel).foregroundStyle(Theme.ink)
            Button(action: onVoice) { Label("Record a voice note", systemImage: "mic") }
                .buttonStyle(.secondary)
                .accessibilityIdentifier("care.tell.voice")
            Button(action: onNote) { Label("Type a note", systemImage: "square.and.pencil") }
                .buttonStyle(.secondary)
                .accessibilityIdentifier("care.tell.note")
        }
        .accessibilityElement(children: .contain)
    }
}
