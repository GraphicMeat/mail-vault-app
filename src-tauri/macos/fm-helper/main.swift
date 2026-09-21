// mailvault-fm-helper — the only place MailVault touches Apple's on-device
// Foundation Models. It exists as a separate binary for two reasons: the API is
// Swift-only (the daemon is Rust), and the framework does not exist on the
// macOS versions this app still supports, so the linkage has to be weak and
// the call site version-gated. A machine without Apple Intelligence gets an
// "unavailable" line, never a crash and never a stall.
//
// Protocol: one JSON object per line on stdin, one JSON object per line on
// stdout, `id` echoed back so the caller can pair them.
//   {"id":"1","op":"availability"}          -> {"id":"1","ok":true,"available":true,"reason":""}
//   {"id":"2","op":"generate","prompt":"…","system":"…","maxTokens":512}
//                                            -> {"id":"2","ok":true,"text":"…"}
// Anything that fails answers {"id":…,"ok":false,"error":"…"} instead.

import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

struct Request: Decodable {
  let id: String
  let op: String
  var prompt: String?
  var system: String?
  var maxTokens: Int?
}

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
        let line = String(data: data, encoding: .utf8) else { return }
  print(line)
  fflush(stdout)
}

func fail(_ id: String, _ message: String) {
  emit(["id": id, "ok": false, "error": message])
}

/// `(available, reason)` — the reason is empty when it is available, and
/// carries Apple's own wording for why not when it is not.
func availability() -> (Bool, String) {
  #if canImport(FoundationModels)
  if #available(macOS 26.0, *) {
    switch SystemLanguageModel.default.availability {
    case .available: return (true, "")
    case .unavailable(let reason): return (false, "\(reason)")
    @unknown default: return (false, "unknown")
    }
  }
  return (false, "This version of macOS has no on-device model.")
  #else
  return (false, "Built without FoundationModels.")
  #endif
}

func generate(_ request: Request) async {
  let id = request.id
  guard let prompt = request.prompt, !prompt.isEmpty else {
    return fail(id, "A generate request needs a prompt.")
  }
  #if canImport(FoundationModels)
  if #available(macOS 26.0, *) {
    let (ok, reason) = availability()
    guard ok else { return fail(id, reason) }
    do {
      let session = request.system.map { LanguageModelSession(instructions: $0) } ?? LanguageModelSession()
      var options = GenerationOptions()
      if let maxTokens = request.maxTokens {
        options = GenerationOptions(maximumResponseTokens: maxTokens)
      }
      let response = try await session.respond(to: prompt, options: options)
      emit(["id": id, "ok": true, "text": response.content])
    } catch {
      fail(id, "\(error)")
    }
    return
  }
  #endif
  fail(id, availability().1)
}

while let line = readLine(strippingNewline: true) {
  let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty { continue }
  guard let data = trimmed.data(using: .utf8),
        let request = try? JSONDecoder().decode(Request.self, from: data) else {
    emit(["id": "", "ok": false, "error": "Unreadable request."])
    continue
  }
  switch request.op {
  case "availability":
    let (ok, reason) = availability()
    emit(["id": request.id, "ok": true, "available": ok, "reason": reason])
  case "generate":
    await generate(request)
  default:
    fail(request.id, "Unknown op '\(request.op)'.")
  }
}
