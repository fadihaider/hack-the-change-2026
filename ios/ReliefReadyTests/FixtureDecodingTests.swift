import Foundation
import Testing
@testable import ReliefReady

/// every captured server reply decodes into its model
struct FixtureDecodingTests {
    /// fixture name -> the model it decodes into
    static let decoders: [String: @Sendable (Data) throws -> Any] = [
        "add-to-timeline": { try JSONDecoder().decode(TimelineAddResponse.self, from: $0) },
        "ask-found": { try JSONDecoder().decode(AskResponse.self, from: $0) },
        "ask-medical": { try JSONDecoder().decode(AskResponse.self, from: $0) },
        "ask-notfound": { try JSONDecoder().decode(AskResponse.self, from: $0) },
        "care-access-area": { try JSONDecoder().decode(AccessAreaPlaces.self, from: $0) },
        "care-access-basemap": { try JSONDecoder().decode(AccessBasemap.self, from: $0) },
        "care-access-home": { try JSONDecoder().decode(HomeAccess.self, from: $0) },
        "care-access-scores": { try JSONDecoder().decode(AccessScores.self, from: $0) },
        "care-add-note": { try JSONDecoder().decode(CareSourceResult.self, from: $0) },
        "care-contacts": { try JSONDecoder().decode(CareContactList.self, from: $0) },
        "care-facts": { try JSONDecoder().decode(CareProfile.self, from: $0) },
        "care-source": { try JSONDecoder().decode(CareSourceDetail.self, from: $0) },
        "care-timeline": { try JSONDecoder().decode(CareTimeline.self, from: $0) },
        "clock": { try JSONDecoder().decode(ClockView.self, from: $0) },
        "contact-add": { try JSONDecoder().decode(CareContactEnvelope.self, from: $0) },
        "decide": { try JSONDecoder().decode(DecideResponse.self, from: $0) },
        "fact-approve": { try JSONDecoder().decode(FactEnvelope.self, from: $0) },
        "guide": { try JSONDecoder().decode(GuideResponse.self, from: $0) },
        "impact": { try JSONDecoder().decode(ImpactResponse.self, from: $0) },
        "intake-clarify": { try JSONDecoder().decode(IntakeResponse.self, from: $0) },
        "intake-ready": { try JSONDecoder().decode(IntakeResponse.self, from: $0) },
        "nearby": { try JSONDecoder().decode(NearbyResponse.self, from: $0) },
        "outbox": { try JSONDecoder().decode(Outbox.self, from: $0) },
        "recover": { try JSONDecoder().decode(RecoverResponse.self, from: $0) },
        "recover-refresh": { try JSONDecoder().decode(RecoverResponse.self, from: $0) },
        "request-approve": { try JSONDecoder().decode(RequestEnvelope.self, from: $0) },
        "request-edit": { try JSONDecoder().decode(RequestEnvelope.self, from: $0) },
        "request-one": { try JSONDecoder().decode(RequestEnvelope.self, from: $0) },
        "request-send": { try JSONDecoder().decode(SendResult.self, from: $0) },
        "requests": { try JSONDecoder().decode(RequestList.self, from: $0) },
        "requests-refresh": { try JSONDecoder().decode(RequestRefresh.self, from: $0) },
        "response-accept": { try JSONDecoder().decode(ResponseResult.self, from: $0) },
        "session": { try JSONDecoder().decode(Session.self, from: $0) },
        "session-empty": { try JSONDecoder().decode(Session.self, from: $0) },
        "sms-draft": { try JSONDecoder().decode(SmsDraft.self, from: $0) },
        "sms-list": { try JSONDecoder().decode(SmsList.self, from: $0) },
        "sms-recipients": { try JSONDecoder().decode(SmsRecipients.self, from: $0) },
    ]

    /// error replies decode as APIError, with the status they came with
    static let errors: [String: Int] = ["error-not-found": 404, "error-precondition": 428, "error-invalid-input": 400]

    @Test func everyFixtureHasADecoder() {
        let covered = Set(Self.decoders.keys).union(Self.errors.keys)
        let names = Fixtures.names
        #expect(names.count >= 38)
        #expect(Set(names) == covered, "fixtures without a decoder: \(Set(names).subtracting(covered).sorted())")
    }

    @Test(arguments: decoders.keys.sorted())
    func decodes(_ name: String) throws {
        let data = try Fixtures.data(name)
        let decoder = try #require(Self.decoders[name])
        _ = try decoder(data)
    }

    @Test(arguments: errors.keys.sorted())
    func errorFixtureDecodesAsAPIError(_ name: String) throws {
        let status = try #require(Self.errors[name])
        let error = APIError.from(status: status, body: try Fixtures.data(name), retryAfter: nil)
        let expected = ["error-not-found": "not_found", "error-precondition": "precondition_required", "error-invalid-input": "invalid_input"]
        #expect(error.code == expected[name])
        #expect(error.status == status)
        #expect(error.terms.isEmpty)
        #expect(error.detail == nil)
    }

    // spot checks: closed sets decode to known cases, not the fallback

    @Test func sessionFieldsAndDefaults() throws {
        let session = try Fixtures.decode(Session.self, "session")
        #expect(session.episode?.startsOn == "2026-11-08")
        #expect(session.mode.sms == "demo")
        #expect(session.providers == Providers(speech: .off, retrieval: .keyword))
        let empty = try Fixtures.decode(Session.self, "session-empty")
        #expect(empty.episode == nil)
        #expect(empty.mode.sms == nil)
        #expect(empty.providers == .defaults)
        #expect(empty.careRecipient?.displayName == "Rosa")
    }

    @Test func intakeUnion() throws {
        let ready = try Fixtures.decode(IntakeResponse.self, "intake-ready")
        guard case .ready(let value) = ready.result else { Issue.record("expected ready"); return }
        #expect(value.endDate == "2026-11-14")
        #expect(ready.episodeId != nil)
        let clarify = try Fixtures.decode(IntakeResponse.self, "intake-clarify")
        guard case .needsClarification(let question) = clarify.result else { Issue.record("expected clarify"); return }
        #expect(question.clarifyingQuestions.count == 2)
        #expect(question.partial.startDate == nil)
        #expect(clarify.episodeId == nil)
    }

    @Test func impactAndDecide() throws {
        let impact = try Fixtures.decode(ImpactResponse.self, "impact")
        #expect(impact.modelStatus == .ok)
        let first = try #require(impact.commitments.first)
        #expect(first.suggestedAction == .reschedule)
        #expect(first.dependencies.first?.contactName == "Jordan Lee")
        let decide = try Fixtures.decode(DecideResponse.self, "decide")
        #expect(decide.commitment.decision == .reschedule)
        #expect(decide.request?.state == .awaitingApproval)
        #expect(decide.request.map { APIClient.isRevision($0.revision) } == true)
    }

    @Test func requestStatesAndSend() throws {
        let approved = try Fixtures.decode(RequestEnvelope.self, "request-approve")
        #expect(approved.request.state == .approved)
        #expect(approved.request.approval != nil)
        #expect(approved.request.evidence.allSatisfy { $0.evidenceKind != .unrecognized })
        let one = try Fixtures.decode(RequestEnvelope.self, "request-one")
        #expect(one.appNow != nil)
        let send = try Fixtures.decode(SendResult.self, "request-send")
        #expect(send == .requested(messageId: "7851c431-d5ff-4de4-8913-d52978c22940"))
        let recover = try Fixtures.decode(RecoverResponse.self, "recover")
        #expect(recover.groups.handled.first?.state == .accepted)
    }

    @Test func careModels() throws {
        let profile = try Fixtures.decode(CareProfile.self, "care-facts")
        #expect(profile.facts.allSatisfy { $0.status != .unrecognized })
        #expect(profile.facts.first?.version == 1)
        let ask = try Fixtures.decode(AskResponse.self, "ask-found")
        #expect(ask.answeredBy == .demoRules)
        #expect(ask.retrieval.method == .keyword)
        let medical = try Fixtures.decode(AskResponse.self, "ask-medical")
        #expect(medical.medicalRedirect)
        #expect(medical.answeredBy == AnsweredBy.none)
        let contacts = try Fixtures.decode(CareContactList.self, "care-contacts")
        #expect(contacts.contacts.first?.kind == .trusted)
    }

    @Test func accessModels() throws {
        let nearby = try Fixtures.decode(NearbyResponse.self, "nearby")
        #expect(nearby.resources.allSatisfy { $0.type != .unrecognized })
        #expect(nearby.outlines.first?.rings.first?.first != nil)
        #expect(nearby.counts.first?.withinKm == 3)
        let basemap = try Fixtures.decode(AccessBasemap.self, "care-access-basemap")
        #expect(basemap.areas.count == basemap.drivingCoverage.count)
        #expect(basemap.areas.allSatisfy { $0.geometry.type == .polygon && !$0.geometry.polygons.isEmpty })
        #expect(basemap.benchmark.classification.selectedModel == "Random Forest")
        let home = try Fixtures.decode(HomeAccess.self, "care-access-home")
        #expect(home.matchedBy == .name)
        #expect(home.nearest["Pharmacy"]??.minutes == 2.4)
        let scores = try Fixtures.decode(AccessScores.self, "care-access-scores")
        #expect(scores.mode == .driving)
        #expect(scores.categories == ["Pharmacy", "Health Centre"])
        let places = try Fixtures.decode(AccessAreaPlaces.self, "care-access-area")
        #expect(places.areas.count == 1)
        #expect(places.areas[0].resources.first?.resource.wheelchair == nil)
    }

    @Test func basemapGeometrySkipsUnusablePoints() throws {
        // zod takes any coordinates array; the web map skips points that are not two finite numbers
        let polygon = Data(#"{"type":"Polygon","coordinates":[[[-114.1,51.0,1048],null,[-114.2],["x",1],[-114.3,51.1]],"bad"]}"#.utf8)
        let geometry = try JSONDecoder().decode(AreaGeometry.self, from: polygon)
        #expect(geometry.polygons == [[[LonLat(lon: -114.1, lat: 51.0), LonLat(lon: -114.3, lat: 51.1)], []]])
        let multi = Data(#"{"type":"MultiPolygon","coordinates":[[[[-114,51],[-114.5,51.5,3]]],7]}"#.utf8)
        let many = try JSONDecoder().decode(AreaGeometry.self, from: multi)
        #expect(many.polygons == [[[LonLat(lon: -114, lat: 51), LonLat(lon: -114.5, lat: 51.5)]], []])
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(AreaGeometry.self, from: Data(#"{"type":"Polygon","coordinates":{}}"#.utf8))
        }
        // nearby outlines mirror z.tuple, so they stay strict
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(CommunityOutline.self, from: Data(#"{"name":"A","rings":[[[-114,51,3]]]}"#.utf8))
        }
    }

    @Test func smsModels() throws {
        let draft = try Fixtures.decode(SmsDraft.self, "sms-draft")
        #expect(draft.parts.encoding == .gsm)
        let recipients = try Fixtures.decode(SmsRecipients.self, "sms-recipients")
        #expect(recipients.provider == .demo)
        #expect(recipients.options.first?.kind == .careContact)
    }

    @Test func outboxReplyLinks() throws {
        let outbox = try Fixtures.decode(Outbox.self, "outbox")
        let links = try #require(outbox.messages.first).responseLinks
        #expect(links.map(\.choice) == [.accept, .decline, .propose])
        #expect(links.allSatisfy { $0.token.count == 43 && $0.url.hasSuffix($0.token) })
    }

    @Test func unknownWordsFallBack() throws {
        let json = Data(#"{"state":"brand_new","delivery":"teleported"}"#.utf8)
        struct Probe: Decodable {
            var state: RequestState
            var delivery: SmsDelivery
        }
        let probe = try JSONDecoder().decode(Probe.self, from: json)
        #expect(probe.state == .unrecognized)
        #expect(probe.delivery == .unrecognized)
        #expect(try JSONDecoder().decode(Wheelchair.self, from: Data(#""maybe""#.utf8)) == .unknown)
    }
}
