"""Conservative visible-region check; not proof that an occluded card is absent."""
import cv2
import numpy as np


def inspect_regions(image, detector):
    image = cv2.resize(image, (384, 384), interpolation=cv2.INTER_LINEAR)
    first = detector.detect(image)
    primary = np.asarray(first.corners, dtype=np.float32) * 384
    area = abs(cv2.contourArea(primary)) / (384 * 384)
    result = {"state": "ambiguous", "method": "cornelius-masked-region-v1", "primarySharpness": float(first.sharpness), "regions": []}
    if first.sharpness < .02:
        return {**result, "state": "none"}
    if not .12 < area < .98 or not cv2.isContourConvex(primary):
        return result
    result["regions"] = [np.asarray(first.corners).tolist()]
    masked = image.copy()
    center = primary.mean(axis=0)
    cv2.fillConvexPoly(masked, np.rint(center + (primary-center)*1.04).astype(np.int32), (127,127,127))
    second = detector.detect(masked)
    secondary = np.asarray(second.corners, dtype=np.float32) * 384
    secondary_area = abs(cv2.contourArea(secondary))
    usable = .06 < secondary_area/(384*384) < .98 and cv2.isContourConvex(secondary)
    outside = 1-cv2.intersectConvexConvex(primary, secondary)[0]/secondary_area if usable else 0
    result.update(secondarySharpness=float(second.sharpness), secondaryOutside=float(outside))
    if usable and outside > .2 and second.sharpness >= .02:
        return {**result, "state": "multiple", "regions": [*result["regions"], np.asarray(second.corners).tolist()]}
    if first.sharpness < .06 or (usable and outside > .1 and second.sharpness >= .01):
        return result
    return {**result, "state": "single"}
