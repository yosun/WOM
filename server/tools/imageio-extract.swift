// Decode an image file with macOS ImageIO and write out everything it holds:
//   - every top-level image ("frame"; a HEIC can hold several) as JPEG, with its orientation kept,
//   - the auxiliary images Apple cameras store with a photo: depth or disparity (as float32 plus a
//     preview PNG) and the portrait / semantic segmentation mattes (as PNG), turned upright.
// Prints a JSON description on stdout. Used by the WOM server for HEIC/HEIF uploads.
//
//   imageio-extract <input> <output dir> [--thumbs <max px>]
import AVFoundation
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Frame: Encodable {
  let index: Int
  let width: Int
  let height: Int
  let orientation: Int
  let file: String
  let thumb: String?
}

struct Aux: Encodable {
  let type: String
  let width: Int
  let height: Int
  let file: String?
  let preview: String?
  let accuracy: String?
  let quality: String?
  let filtered: Bool?
  let min: Float?
  let max: Float?
}

struct Output: Encodable {
  let uti: String
  let count: Int
  let primaryIndex: Int
  let frames: [Frame]
  let aux: [Aux]
  let notes: [String]
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: imageio-extract <input> <output dir> [--thumbs <max px>]") }
let input = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2], isDirectory: true)
var thumbMax = 0
if let i = args.firstIndex(of: "--thumbs"), i + 1 < args.count { thumbMax = Int(args[i + 1]) ?? 0 }
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

guard let src = CGImageSourceCreateWithURL(input as CFURL, nil) else { fail("ImageIO cannot open the file") }
let uti = (CGImageSourceGetType(src) as String?) ?? "unknown"
let count = CGImageSourceGetCount(src)
if count == 0 { fail("the file holds no image") }
let primary = CGImageSourceGetPrimaryImageIndex(src)
var notes: [String] = []

func writeImage(_ image: CGImage, to url: URL, type: UTType, properties: [CFString: Any]) -> Bool {
  guard let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else { return false }
  CGImageDestinationAddImage(dest, image, properties as CFDictionary)
  return CGImageDestinationFinalize(dest)
}

// 1. Every top-level image.
var frames: [Frame] = []
for i in 0..<count {
  let props = (CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any]) ?? [:]
  let orientation = (props[kCGImagePropertyOrientation] as? Int) ?? 1
  guard let image = CGImageSourceCreateImageAtIndex(src, i, nil) else {
    notes.append("frame \(i) could not be decoded")
    continue
  }
  let name = "frame-\(i).jpg"
  // Keep the camera's metadata and orientation; the server turns the image upright.
  var out: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.95, kCGImagePropertyOrientation: orientation]
  for key in [kCGImagePropertyExifDictionary, kCGImagePropertyTIFFDictionary, kCGImagePropertyGPSDictionary, kCGImagePropertyExifAuxDictionary] {
    if let v = props[key] { out[key] = v }
  }
  guard writeImage(image, to: outDir.appendingPathComponent(name), type: .jpeg, properties: out) else { fail("could not write \(name)") }
  var thumb: String? = nil
  if thumbMax > 0 {
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: thumbMax,
    ]
    if let t = CGImageSourceCreateThumbnailAtIndex(src, i, opts as CFDictionary) {
      let tname = "thumb-\(i).jpg"
      if writeImage(t, to: outDir.appendingPathComponent(tname), type: .jpeg, properties: [kCGImageDestinationLossyCompressionQuality: 0.85]) { thumb = tname }
    }
  }
  frames.append(Frame(index: i, width: image.width, height: image.height, orientation: orientation, file: name, thumb: thumb))
}

// 2. Auxiliary images of the primary photo, turned like the photo.
let primaryProps = (CGImageSourceCopyPropertiesAtIndex(src, primary, nil) as? [CFString: Any]) ?? [:]
let exifOrientation = UInt32((primaryProps[kCGImagePropertyOrientation] as? Int) ?? 1)
let ciContext = CIContext(options: [.useSoftwareRenderer: false])
var aux: [Aux] = []

func writePNG(_ buffer: CVPixelBuffer, name: String) -> Bool {
  let image = CIImage(cvPixelBuffer: buffer)
  let space = CGColorSpace(name: CGColorSpace.linearGray) ?? CGColorSpaceCreateDeviceGray()
  do {
    try ciContext.writePNGRepresentation(of: image, to: outDir.appendingPathComponent(name), format: .L8, colorSpace: space)
    return true
  } catch {
    return false
  }
}

func depthEntry(kind: CFString, label: String) {
  guard let info = CGImageSourceCopyAuxiliaryDataInfoAtIndex(src, primary, kind) as? [AnyHashable: Any] else { return }
  guard var depth = try? AVDepthData(fromDictionaryRepresentation: info) else {
    notes.append("\(label) present but could not be read")
    return
  }
  if let o = CGImagePropertyOrientation(rawValue: exifOrientation), o != .up { depth = depth.applyingExifOrientation(o) }
  // Float32 metres (or 1/metre for disparity), row-major, little-endian.
  let wanted = label == "disparity" ? kCVPixelFormatType_DisparityFloat32 : kCVPixelFormatType_DepthFloat32
  let converted = depth.depthDataType == wanted ? depth : depth.converting(toDepthDataType: wanted)
  let map = converted.depthDataMap
  CVPixelBufferLockBaseAddress(map, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
  let w = CVPixelBufferGetWidth(map), h = CVPixelBufferGetHeight(map), stride = CVPixelBufferGetBytesPerRow(map)
  guard let base = CVPixelBufferGetBaseAddress(map) else { return }
  var values = [Float](repeating: .nan, count: w * h)
  var lo = Float.greatestFiniteMagnitude, hi = -Float.greatestFiniteMagnitude
  for y in 0..<h {
    let row = base.advanced(by: y * stride).assumingMemoryBound(to: Float.self)
    for x in 0..<w {
      let v = row[x]
      values[y * w + x] = v
      if v.isFinite { lo = min(lo, v); hi = max(hi, v) }
    }
  }
  let file = "aux-\(label).f32"
  values.withUnsafeBufferPointer { try? Data(buffer: $0).write(to: outDir.appendingPathComponent(file)) }
  // An 8-bit preview, near = bright.
  var preview: String? = nil
  if hi > lo, let pb = makeGray(w: w, h: h, fill: { i in
    let v = values[i]
    guard v.isFinite else { return 0 }
    let t = (v - lo) / (hi - lo)
    return UInt8(max(0, min(255, (label == "disparity" ? t : 1 - t) * 255)))
  }) {
    if writePNG(pb, name: "aux-\(label).png") { preview = "aux-\(label).png" }
  }
  let accuracy = converted.depthDataAccuracy == .absolute ? "absolute" : "relative"
  let quality = converted.depthDataQuality == .high ? "high" : "low"
  aux.append(Aux(type: label, width: w, height: h, file: file, preview: preview, accuracy: accuracy, quality: quality, filtered: converted.isDepthDataFiltered, min: lo, max: hi))
}

func makeGray(w: Int, h: Int, fill: (Int) -> UInt8) -> CVPixelBuffer? {
  var pb: CVPixelBuffer?
  guard CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_OneComponent8, nil, &pb) == kCVReturnSuccess, let buf = pb else { return nil }
  CVPixelBufferLockBaseAddress(buf, [])
  defer { CVPixelBufferUnlockBaseAddress(buf, []) }
  guard let base = CVPixelBufferGetBaseAddress(buf) else { return nil }
  let stride = CVPixelBufferGetBytesPerRow(buf)
  for y in 0..<h {
    let row = base.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self)
    for x in 0..<w { row[x] = fill(y * w + x) }
  }
  return buf
}

depthEntry(kind: kCGImageAuxiliaryDataTypeDepth, label: "depth")
depthEntry(kind: kCGImageAuxiliaryDataTypeDisparity, label: "disparity")

if let info = CGImageSourceCopyAuxiliaryDataInfoAtIndex(src, primary, kCGImageAuxiliaryDataTypePortraitEffectsMatte) as? [AnyHashable: Any] {
  if var matte = try? AVPortraitEffectsMatte(fromDictionaryRepresentation: info) {
    if let o = CGImagePropertyOrientation(rawValue: exifOrientation), o != .up { matte = matte.applyingExifOrientation(o) }
    let buf = matte.mattingImage
    let name = "aux-portrait-matte.png"
    if writePNG(buf, name: name) {
      aux.append(Aux(type: "portrait-matte", width: CVPixelBufferGetWidth(buf), height: CVPixelBufferGetHeight(buf), file: name, preview: name, accuracy: nil, quality: nil, filtered: nil, min: nil, max: nil))
    }
  } else {
    notes.append("portrait matte present but could not be read")
  }
}

let semantic: [(CFString, String)] = [
  (kCGImageAuxiliaryDataTypeSemanticSegmentationSkyMatte, "sky-matte"),
  (kCGImageAuxiliaryDataTypeSemanticSegmentationHairMatte, "hair-matte"),
  (kCGImageAuxiliaryDataTypeSemanticSegmentationSkinMatte, "skin-matte"),
  (kCGImageAuxiliaryDataTypeSemanticSegmentationTeethMatte, "teeth-matte"),
  (kCGImageAuxiliaryDataTypeSemanticSegmentationGlassesMatte, "glasses-matte"),
]
for (kind, label) in semantic {
  guard let info = CGImageSourceCopyAuxiliaryDataInfoAtIndex(src, primary, kind) as? [AnyHashable: Any] else { continue }
  guard var matte = try? AVSemanticSegmentationMatte(fromImageSourceAuxiliaryDataType: kind, dictionaryRepresentation: info) else {
    notes.append("\(label) present but could not be read")
    continue
  }
  if let o = CGImagePropertyOrientation(rawValue: exifOrientation), o != .up { matte = matte.applyingExifOrientation(o) }
  let buf = matte.mattingImage
  let name = "aux-\(label).png"
  if writePNG(buf, name: name) {
    aux.append(Aux(type: label, width: CVPixelBufferGetWidth(buf), height: CVPixelBufferGetHeight(buf), file: name, preview: name, accuracy: nil, quality: nil, filtered: nil, min: nil, max: nil))
  }
}

if CGImageSourceCopyAuxiliaryDataInfoAtIndex(src, primary, kCGImageAuxiliaryDataTypeHDRGainMap) != nil {
  aux.append(Aux(type: "hdr-gain-map", width: 0, height: 0, file: nil, preview: nil, accuracy: nil, quality: nil, filtered: nil, min: nil, max: nil))
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
let json = try encoder.encode(Output(uti: uti, count: count, primaryIndex: primary, frames: frames, aux: aux, notes: notes))
FileHandle.standardOutput.write(json)
