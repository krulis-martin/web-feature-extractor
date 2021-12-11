/*
 * Color conversions.
 */

function RGBtoGreyscale(imgData, offset, gsMax)
{
	var R = imgData[offset]   / 255;
	var G = imgData[offset+1] / 255;
	var B = imgData[offset+2] / 255;
	
	return Math.round(gsMax * (0.3*R + 0.59*G + 0.11*B));
}


var _D65 = { X: 0.9505, Y: 1.0, Z: 1.0890 };

function _Fxyz(t)
{
	return ((t > 0.008856)
		? Math.pow(t, (1.0/3.0))
		: (7.787*t + 16.0/116.0));
}


function RGBtoLAB(imgData, offset)
{
	// normalize red, green, blue values
	var rLinear = imgData[offset]   / 255;
	var gLinear = imgData[offset+1] / 255;
	var bLinear = imgData[offset+2] / 255;

	// convert to a sRGB form
	var r = (rLinear > 0.04045) ? Math.pow((rLinear + 0.055) / (1 + 0.055), 2.2) : (rLinear / 12.92);
	var g = (gLinear > 0.04045) ? Math.pow((gLinear + 0.055) / (1 + 0.055), 2.2) : (gLinear / 12.92);
	var b = (bLinear > 0.04045) ? Math.pow((bLinear + 0.055) / (1 + 0.055), 2.2) : (bLinear / 12.92);

	// convert to XYZ
	var X = r*0.4124 + g*0.3576 + b*0.1805;
	var Y = r*0.2126 + g*0.7152 + b*0.0722;
	var Z = r*0.0193 + g*0.1192 + b*0.9505;


	var L = 116.0 * _Fxyz(Y / _D65.Y) - 16;
	var a = 500.0 * (_Fxyz(X / _D65.X) - _Fxyz(Y / _D65.Y));
	var b = 200.0 * (_Fxyz(Y / _D65.Y) - _Fxyz(Z / _D65.Z));

	return { L: L, a: a, b: b };
}



function _incMatrix(matrix, x, y, width)
{
	if (x <= y)
		++matrix[y*width + x];
	else
		++matrix[x*width + y];
}


function computeContrastEntropy(image, X, Y, r, gs)
{
	var fromX = Math.max(X - r, 0);
	var fromY = Math.max(Y - r, 0);
	var toX = Math.min(X + r, image.width - 1);
	var toY = Math.min(Y + r, image.height - 1);
	var width = toX - fromX + 1;
	var height = toY - fromY + 1;
	
	// Convert image window to greyscale.
	var gsImage = [];
	for (var y = fromY; y <= toY; ++y)
		for (var x = fromX; x <= toX; ++x) {
			gsImage.push(RGBtoGreyscale(image.data, y*image.width + x, gs-1));
		}
	
	// Prepare coocurance matrix.	
	var matrix = new Array((gs+1)*(gs+1));
	for (var i = 0; i < matrix.length; ++i) matrix[i] = 0;
	
	for (var y = 0; y < height-1; ++y)
		for (var x = 0; x < width-1; ++x) {
			_incMatrix(matrix, gsImage[y*width + x], gsImage[y*width + x + 1], gs);
			_incMatrix(matrix, gsImage[y*width + x], gsImage[(y+1)*width + x], gs);
			_incMatrix(matrix, gsImage[y*width + x], gsImage[(y+1)*width + x + 1], gs);
			_incMatrix(matrix, gsImage[y*width + x + 1], gsImage[(y+1)*width + x], gs);
		}
	
	var contrast = 0;
	var entropy = 0;
	var normalizer = (width-1)*(height-1)*4;
	for (var j = 0; j < gs; ++j)
		for (var i = 0; i <= j; ++i) {
			if (matrix[j*gs + i] != 0) {
				var value = matrix[j*gs + i] / normalizer;
				contrast += (i - j) * (i - j) * value; 
				entropy -= value * Math.log(value);
			}
		}
	
	return { c: contrast, e: entropy };
}



function _pointDist(p1, p2)
{
	return Math.sqrt((p1.x - p2.x) * (p1.x - p2.x)
		+ (p1.y - p2.y) * (p1.y - p2.y)
		+ (p1.L - p2.L) * (p1.L - p2.L)
		+ (p1.a - p2.a) * (p1.a - p2.a)
		+ (p1.b - p2.b) * (p1.b - p2.b)
		+ (p1.c - p2.c) * (p1.c - p2.c)
		+ (p1.e - p2.e) * (p1.e - p2.e)
	);
}


function _addPoints(point, addPoint)
{
	point.x += addPoint.x;
	point.y += addPoint.y;
	point.L += addPoint.L;
	point.a += addPoint.a;
	point.b += addPoint.b;
	point.c += addPoint.c;
	point.e += addPoint.e;
	++point.weight;
}


function _normalizeCentroid(centroid)
{
	if (centroid.weight == 0) return;
	centroid.x /= centroid.weight;
	centroid.y /= centroid.weight;
	centroid.L /= centroid.weight;
	centroid.a /= centroid.weight;
	centroid.b /= centroid.weight;
	centroid.c /= centroid.weight;
	centroid.e /= centroid.weight;
}



function _getNearest(point, centroids)
{
	var nearest = 0;
	var minDist = _pointDist(point, centroids[0]);
	for (var i = 1; i < centroids.length; ++i) {
		var dist = _pointDist(point, centroids[i]);
		if (dist < minDist) {
			minDist = dist;
			nearest = i;
		}
	}
	return nearest;
}



function _newCentroids(points, centroids)
{
	// Prepare new array of zeroed centroids.
	var newCentroids = [];
	for (var i = 0; i < centroids.length; ++i)
		newCentroids.push({ x: 0, y: 0, L: 0, a: 0, b: 0, c: 0, e: 0, weight: 0 });
	
	// Compute assignment and accumulate coordinates.
	for (var i = 0; i < points.length; ++i) {
		var nearest = _getNearest(points[i], centroids);
		_addPoints(newCentroids[nearest], points[i]);
	}
	
	// Normalize centroids (divide coordinates by weights).
	for (var i = 0; i < newCentroids.length; ++i)
		_normalizeCentroid(newCentroids[i]);
	
	return newCentroids;
}


function kmeans(points, seeds, iters, joinDist, minSize)
{
	// Create inital set of centroids.
	var centroids = [];
	for (var i = 0; i < seeds; ++i)
		centroids.push(points[i]);
	
	// Perform prescribed amount of iterations.
	for (var iter = 0; iter < iters; ++iter) {
		centroids = _newCentroids(points, centroids);

		// Join closeby centroids.
		for (var i = 0; i < centroids.length-1; ++i)
			for (var j = i+1; j < centroids.length; ++j) {
				if (_pointDist(centroids[i], centroids[j]) < joinDist) {
					centroids.weight = 0;
				}
			}
		
		// Remove too small clusters.
		centroids = centroids.filter(function(centroid){
			return centroid.weight > minSize*iter;
		});
	}
	
	return centroids;
}


function _cmp(s1, s2)
{
	return s2.weight - s1.weight;
}


function extractFeatures(image, configuration)
{
	// Prepare initial samples.
	var samples = [];
	for (var i = 0; i < configuration.pointCount; ++i) {
		var x = Math.round(configuration.points[i].x * image.width);
		var y = Math.round(configuration.points[i].y * image.height);
		var Lab = RGBtoLAB(image.data, (y*image.width + x)*4);
		var ce = computeContrastEntropy(image, x, y, configuration.radius, configuration.greyscale, i == 42);

		// Final normalization and assembly of the feature point.
		samples.push({
			x: (x / image.width) * configuration.fsWeights.x,
			y: (y / image.height) * configuration.fsWeights.y,
			L: Math.round(Lab.L)/100 * configuration.fsWeights.L,
			a: Math.round(Lab.a)/50 * configuration.fsWeights.a,
			b: Math.round(Lab.b)/50 * configuration.fsWeights.b,
			c: ce.c/25 * configuration.fsWeights.c,
			e: ce.e/4 * configuration.fsWeights.e
		});
		

	}
	
	// Get the signature from samples by k-means clustering.
	var signature = kmeans(samples, configuration.seeds, configuration.iterations, configuration.joinThreshold, configuration.clusterMinSize);
	signature.sort(_cmp);
	
	// Normalize weights.
	var sum = 0;
	for (var i = 0; i < signature.length; ++i)
		sum += signature[i].weight;
	for (var i = 0; i < signature.length; ++i)
		signature[i].weight /= sum;

	return signature;
}





// Message handler (each message represent one image to be extracted).
onmessage = function(e)
{
	var data = e.data;
	var startTime = Date.now();
	try {
		data.signature = extractFeatures(data.image, data.configuration);
		data.elapsedTime = Date.now() - startTime;
		postMessage(data);
	}
	catch(e) {
		data.error = e;
		postMessage(data);
	} 
};
