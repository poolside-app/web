// =============================================================================
// encode.swift — the demo video's MP4, with Apple's own AVFoundation
// =============================================================================
// No downloads: macOS can make H.264 video and AAC sound itself. record.mjs
// builds it (with an overlay for a Command Line Tools bug) and runs it:
//   encode frames.json voice.json out.mp4
// frames.json: { "end": seconds, "frames": [{ "f": "/path/0001.jpg", "t": seconds }] }
//   (screenshots as they arrived; each is held until the next one)
// voice.json:  [{ "f": "/path/scene1.aiff", "t": seconds }]  (where each line starts)
// =============================================================================

import AVFoundation
import CoreGraphics
import Foundation
import ImageIO

struct Frame: Decodable { let f: String; let t: Double }
struct Frames: Decodable { let end: Double; let frames: [Frame] }
struct Voice: Decodable { let f: String; let t: Double }

let args = CommandLine.arguments
guard args.count == 4 else { print("usage: encode frames.json voice.json out.mp4"); exit(2) }
let frames = try JSONDecoder().decode(Frames.self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
let voice = try JSONDecoder().decode([Voice].self, from: Data(contentsOf: URL(fileURLWithPath: args[2])))
let out = URL(fileURLWithPath: args[3])
let silent = out.deletingPathExtension().appendingPathExtension("silent.mp4")
try? FileManager.default.removeItem(at: silent)
try? FileManager.default.removeItem(at: out)

// DEMO_SIZE=720: a smaller copy for phones and email (about 25 MB for 2.5 minutes).
let small = ProcessInfo.processInfo.environment["DEMO_SIZE"] == "720"
let W = small ? 1280 : 1920, H = small ? 720 : 1080, FPS: Int32 = 30
// Mostly still screens. DEMO_BITRATE (bits a second) overrides, e.g. 600000
// to keep a 5-minute small copy under 30 MB (phones and email).
let BITRATE = Int(ProcessInfo.processInfo.environment["DEMO_BITRATE"] ?? "") ?? (small ? 1_250_000 : 3_000_000)

func image(_ path: String) -> CGImage? {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

// ── 1. The picture: 30 frames a second, each holding the latest screenshot ──
let writer = try AVAssetWriter(outputURL: silent, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: W, AVVideoHeightKey: H,
  AVVideoCompressionPropertiesKey: [
    AVVideoAverageBitRateKey: BITRATE,
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    AVVideoMaxKeyFrameIntervalKey: 60,
  ],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
  kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H,
])
writer.add(input)
guard writer.startWriting() else { print("writer:", writer.error as Any); exit(1) }
writer.startSession(atSourceTime: .zero)

func buffer(for img: CGImage) -> CVPixelBuffer? {
  guard let pool = adaptor.pixelBufferPool else { return nil }
  var pb: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
  guard let b = pb else { return nil }
  CVPixelBufferLockBaseAddress(b, [])
  let ctx = CGContext(data: CVPixelBufferGetBaseAddress(b), width: W, height: H, bitsPerComponent: 8,
                      bytesPerRow: CVPixelBufferGetBytesPerRow(b), space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
  ctx?.interpolationQuality = .high
  ctx?.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
  CVPixelBufferUnlockBaseAddress(b, [])
  return b
}

let total = Int((frames.end * Double(FPS)).rounded(.up))
var idx = -1, current: CVPixelBuffer? = nil
for n in 0..<total {
  let t = Double(n) / Double(FPS)
  var next = idx
  while next + 1 < frames.frames.count && frames.frames[next + 1].t <= t { next += 1 }
  if next != idx, next >= 0, let img = image(frames.frames[next].f) { current = buffer(for: img); idx = next }
  guard let pb = current else { continue }
  while !input.isReadyForMoreMediaData { usleep(2000) }
  adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(n), timescale: FPS))
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
guard writer.status == .completed else { print("writer failed:", writer.error as Any); exit(1) }

// ── 2. The voice: each line where its scene starts, as one continuous track ──
// The silences are encoded too: some phone players ignore gaps in a track,
// which would slide the voice off the picture.
let picture = AVURLAsset(url: silent)
let voiceComp = AVMutableComposition()
let vo = voiceComp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
for v in voice {
  let a = AVURLAsset(url: URL(fileURLWithPath: v.f))
  guard let src = a.tracks(withMediaType: .audio).first else { print("no audio in", v.f); exit(1) }
  let at = CMTime(seconds: v.t, preferredTimescale: 600)
  let len = CMTimeMinimum(a.duration, CMTimeSubtract(picture.duration, at))
  if CMTimeCompare(len, .zero) > 0 { try vo.insertTimeRange(CMTimeRange(start: .zero, duration: len), of: src, at: at) }
}
let tail = CMTimeSubtract(picture.duration, voiceComp.duration)
if CMTimeCompare(tail, .zero) > 0 { vo.insertEmptyTimeRange(CMTimeRange(start: voiceComp.duration, duration: tail)) }
let voiceFile = out.deletingPathExtension().appendingPathExtension("voice.m4a")
try? FileManager.default.removeItem(at: voiceFile)
guard let vx = AVAssetExportSession(asset: voiceComp, presetName: AVAssetExportPresetAppleM4A) else { print("no voice export"); exit(1) }
vx.outputURL = voiceFile; vx.outputFileType = .m4a
let vDone = DispatchSemaphore(value: 0)
vx.exportAsynchronously { vDone.signal() }
vDone.wait()
guard vx.status == .completed else { print("voice export failed:", vx.error as Any); exit(1) }

// ── 3. Picture and voice together, copied as they are ──
let comp = AVMutableComposition()
let vTrack = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
try vTrack.insertTimeRange(CMTimeRange(start: .zero, duration: picture.duration), of: picture.tracks(withMediaType: .video)[0], at: .zero)
let sound = AVURLAsset(url: voiceFile)
let aTrack = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
try aTrack.insertTimeRange(CMTimeRange(start: .zero, duration: CMTimeMinimum(sound.duration, picture.duration)), of: sound.tracks(withMediaType: .audio)[0], at: .zero)

guard let export = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough) else { print("no export session"); exit(1) }
export.outputURL = out
export.outputFileType = .mp4
export.shouldOptimizeForNetworkUse = true
let exported = DispatchSemaphore(value: 0)
export.exportAsynchronously { exported.signal() }
exported.wait()
guard export.status == .completed else { print("export failed:", export.error as Any); exit(1) }
try? FileManager.default.removeItem(at: silent)
try? FileManager.default.removeItem(at: voiceFile)
print("wrote", out.path, String(format: "%.1f s", CMTimeGetSeconds(comp.duration)))
