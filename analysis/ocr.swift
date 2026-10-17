import Foundation
import Vision
import AppKit
let dir=CommandLine.arguments[1]
let files=(try FileManager.default.contentsOfDirectory(atPath:dir)).filter{$0.hasPrefix("detail-")&&$0.hasSuffix(".jpg")}.sorted()
for f in files {
 autoreleasepool {
  guard let im=NSImage(contentsOfFile:dir+"/"+f),let cg=im.cgImage(forProposedRect:nil,context:nil,hints:nil) else{return}
  let req=VNRecognizeTextRequest();req.recognitionLevel = .accurate;req.recognitionLanguages=["zh-Hans","en-US"];req.usesLanguageCorrection=true
  do {try VNImageRequestHandler(cgImage:cg).perform([req]);let out=(req.results ?? []).compactMap{$0.topCandidates(1).first?.string}.joined(separator:"\n");print("\nFRAME "+f+"\n"+out)}catch{print("OCR error: \(error)")}
 }
}
