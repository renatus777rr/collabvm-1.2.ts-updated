import { Size, Rect } from "../Utilities";

export function BatchRects(size: Size, rects: Array<Rect>): Rect {
	let mergedX = size.width;
	let mergedY = size.height;
	let mergedHeight = 0;
	let mergedWidth = 0;

	// can't batch these
	if (rects.length === 0) {
		return {
			x: 0,
			y: 0,
			width: size.width,
			height: size.height
		};
	}

	if (rects.length === 1) {
		if (rects[0].width === size.width && rects[0].height === size.height) {
			return rects[0];
		}
	}

	rects.forEach((r) => {
		if (r.x < mergedX) mergedX = r.x;
		if (r.y < mergedY) mergedY = r.y;
	});

	rects.forEach((r) => {
		if (r.height + r.y - mergedY > mergedHeight) mergedHeight = r.height + r.y - mergedY;
		if (r.width + r.x - mergedX > mergedWidth) mergedWidth = r.width + r.x - mergedX;
	});

	return {
		x: mergedX,
		y: mergedY,
		width: mergedWidth,
		height: mergedHeight
	};
}
