/*
 * Feature Extraction Routines
 * by Martin Krulis <krulis@ksi.mff.cuni.cz>
 *
 * v0.2, released 6.7.2016
 * License CC BY-NC 4.0 (https://creativecommons.org/licenses/by-nc/4.0/)
 */


// Make sure the FE "namespace" object exists.
if (!("FE" in window))
	window.FE = {};


// Initialize the FE object in a separate function, so it may have some privacy in the closure.
(function(FE){
	/*
	 * Image object that handles metadata and process of feature extraction for single image.
	 */
	
	// Image constructor (initializes empty image).
	FE.Image = function(idx)
	{
		this.idx = idx;
		this.creationTS = Date.now();
		this.image = $("<img>");
		this.fileName = null;
		this.fileSize = null;
		this.fileType = null;
		this.thumbnailCanvas = $("<canvas></canvas>");
		this.thumbnail = null;
	}
	
	FE.Image.prototype = {
		// Load Image data from a file and resize the image on a canvas
		// and (optionally) enqueue it for extraction (if enqueue flag is true).
		load: function(file, enqueue, callback)
		{
			if (!(file instanceof File))
				throw new Error("The file argument must be an instance of File.");
			if (callback && typeof(callback) != "function")
				throw new Error("The callback argument must be a function.");

			// Update file info.			
			this.fileName = file.name;
			this.fileSize = file.size;
			this.fileType = file.type;
			this.image.attr("alt", file.name);

			// save "this" as image in the closure for the following callbacks
			var image = this;	

			// Load the file contents and suply it to the IMG element.
			var reader = new FileReader();
			reader.onload = function(ev) {
				// The image is loaded as data URL ... so we can put it right to src
				image.image.attr("src", ev.target.result);
			};
			reader.readAsDataURL(file);				
			
			// Handle the image load completion ...
			image.image.load(function(){
				image.loadTS = Date.now();
				
				// Compue thumbnail size and resize canvas accordingly.
				var img = image.image[0];	// get the raw HTMLImageElement
				var size = _getThumbSize(img);
				var canvas = image.thumbnailCanvas[0];
				canvas.width = size.width;
				canvas.height = size.height;

				// Draw the resized image and grab canvas data.
				var ctx = canvas.getContext("2d");
				ctx.drawImage(img, 0, 0, size.width, size.height);
				image.thumbnail = ctx.getImageData(0, 0, size.width, size.height);
				image.resizedTS = Date.now();
				
				// If callback was specified, invoke it.
				if (callback)
					callback(image, file);
				
				// If auto-enqueue flag is on, enqueue the image for extraction.
				if (enqueue)
					FE.enqueue(image);
			});
		},


		// Check whether the image has been already extracted.
		isExtracted: function()
		{
			return (this.extractedTS) ? true : false;	
		},

		// Return loading time in ms.
		getLoadTime: function()
		{
			if (!this.loadTS || !this.creationTS)
				throw new Error("The image has not been loaded yet.");	
			return this.loadTS - this.creationTS;
		},
		
		// Return resizing time in ms.
		getResizeTime: function()
		{
			if (!this.resizedTS || !this.loadTS)
				throw new Error("The image has not been resized yet.");	
			return this.resizedTS - this.loadTS;
		},

		// Return extraction time in ms.
		getExtractionTime: function()
		{
			if (!this.extractionTime)
				throw new Error("The image has not been extracted yet.");	
			return this.extractionTime;
		},
		
		// Return time (in ms), how long the image was waiting for extraction in queue.
		getWaitingTime: function()
		{
			if (!this.enqueuedTS || !this.extractedTS)
				throw new Error("The image has not been extracted yet.");	
			return this.extractedTS - this.enqueuedTS - this.getExtractionTime();
		},
		
		// Return total processing (and waiting) time in ms.
		getTotalTime: function()
		{
			if (!this.enqueuedTS || !this.extractedTS)
				throw new Error("The image has not been extracted yet.");	
			return this.getLoadTime() + this.getResizeTime() + this.extractedTS - this.enqueuedTS;
		},
		
		
		// Return feature signature in SVF text format (plain text serialization).
		// The SVF is a sequence of comma separated float numbers in decimal format,
		// where the first two numbers are # of centroids and dimension and the
		// centroid data are concatenated as a weight followed by 7 coordinates.
		getSignatureAsSVF: function()
		{
			if (!this.signature)
				throw new Error("Signature is not available, the image has not been extracted yet.");
			var data = [];
			data.push(this.fileName);
			data.push(this.signature.length);
			data.push(7);
			for (var i = 0; i < this.signature.length; ++i) {
				data.push(this.signature[i].weight);
				data.push(this.signature[i].x);
				data.push(this.signature[i].y);
				data.push(this.signature[i].L);
				data.push(this.signature[i].a);
				data.push(this.signature[i].b);
				data.push(this.signature[i].c);
				data.push(this.signature[i].e);
			}
			
			return data.join(", ");
		}
	};
	
	
	/*
	 * Extraction Workers
	 */
	var extractionWorkers = [];
	var idleWorkers = [];
	var imagesWaiting = [];
	var imagesPending = { counter: 0 };
	var completionCallback = null;
	
	
	// Initialize extraction workers pool.
	FE.initialize = function(workers, completion)
	{
		if (extractionWorkers.length > 0)
			throw new Error("Extraction workers have already been initialized.");
		if (workers < 1 || workers > 64)
			throw new Error("Invalid number of requested workers (must in range 1-64).");
		
		for (var i = 0; i < workers; ++i) {
			extractionWorkers[i] = new Worker("js/worker.js");
			idleWorkers.push(i);
			extractionWorkers[i].onmessage = _workerMessageHandler;
		}
		
		if (completion)
			FE.setCompletionCallback(completion);
	};
	
	
	// Enqueue an image for extraction.
	FE.enqueue = function(image)
	{
		if (!(image instanceof FE.Image))
			throw new Error("Given parameter is not FE.Image object.");
		
		image.signature = null;
		image.extractionTime = null;
		image.extractedTS = null;
		image.enqueuedTS = Date.now();
		if (image.extractionError)
			delete image.extractionError;
		
		if (idleWorkers.length > 0)
			// If worker is available, dispath work immediately.
			_dispatchImage(image, idleWorkers.pop());
		else
			// Otherwise push it into the waiting list.
			imagesWaiting.push(image);
	};
	
	
	// Set callback function, that is invoked whenever an extraction task (submitted by enqueue() method) finishes.
	FE.setCompletionCallback = function(callback)
	{
		if (typeof(callback) != "function" && callback !== null)
			throw new Error("Given callback parameter is not a function.");
		completionCallback = callback;
	};
	
	
	// Fill SVG element with sampling points visualization.
	FE.visualizePoints = function(svg, points)
	{
		if (!points)
			points = FE.Configuration.points;
		
		$(svg).empty();
		var width = svg.getAttribute("width");
		var height = svg.getAttribute("height");
		for (var i = 0; i < points.length; ++i) {
			var x = points[i].x * width;
			var y = points[i].y * height;
			var circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
			circle.setAttribute("cx", x);
			circle.setAttribute("cy", y);
			circle.setAttribute("r", 0.5);
			circle.setAttribute("stroke", "#555599");
			circle.setAttribute("stroke-width", "1");
			svg.appendChild(circle);
		}
	};


	// Fill SVG element with signature visualization.
	// Magnify defines multiplication factor for cluster radii (recomended value is 5).
	FE.visualizeSignature = function(svg, signature, magnify)
	{
		$(svg).empty();
		var width = svg.getAttribute("width");
		var height = svg.getAttribute("height");
		var rFact = Math.min(width, height) * magnify;
		for (var i = 0; i < signature.length; ++i) {
			var point = signature[i];
			var x = point.x / FE.Configuration.fsWeights.x; 
			var y = point.y / FE.Configuration.fsWeights.y; 
			var circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
			circle.setAttribute("cx", Math.round(x * width));
			circle.setAttribute("cy", Math.round(y * height));
			circle.setAttribute("r", Math.round(point.weight * rFact));
			circle.setAttribute("stroke", "#555555");
			circle.setAttribute("stroke-width", "1");
			circle.setAttribute("fill", _LabToRGB(point));
			svg.appendChild(circle);
		}
	};
		
		


	/*
	 * Private Functions
	 */

	// Dispatch image to given worker.
	function _dispatchImage(image, workerId)
	{	
		extractionWorkers[workerId].postMessage({
			idx: imagesPending.counter,
			worker: workerId,
			image: image.thumbnail,
			configuration: FE.Configuration.exportObject()
		});		
		imagesPending[imagesPending.counter++] = image;	
	}


	// Generic handler for onmessage event of all workers (i.e., when a worker finishes extraction).
	function _workerMessageHandler(ev)
	{
		// Handle when image is finished.
		var image = imagesPending[ev.data.idx];
		if (ev.data.error) {
			image.extractionError = ev.data.error;
		}
		else {
			image.signature = ev.data.signature;
			image.extractionTime = ev.data.elapsedTime;

		}
		image.extractedTS = Date.now();
		
		// Manage the finished worker ...
		if (imagesWaiting.length > 0) {
			// There is another image waiing -> dispatch it to the same worker.
			_dispatchImage(imagesWaiting.shift(), ev.data.worker);
		}
		else {
			// No more work -> mark the worker idle.
			idleWorkers.push(ev.data.worker);
		} 
		
		// Invoke the callback
		if (completionCallback)
			completionCallback(image);
	}
	

	// Compute thumbnail size from image size and config parameters.
	function _getThumbSize(img)
	{
		if (FE.Configuration.keepAspectRatio) {
			var width = img.naturalWidth, height = img.naturalHeight;

			if (Math.round(height * FE.Configuration.width / width) > FE.Configuration.height) {
				width = Math.round(width * FE.Configuration.height / height);
				height = FE.Configuration.height;
			}
			else {
				height = Math.round(height * FE.Configuration.width / width);
				width = FE.Configuration.width;
			}
			
			return { width: width, height: height };
		}
		else
			return { width: FE.Configuration.width, height: FE.Configuration.height };
	}


	// Clamp given value to 0-255 range and convert it in hex string.
	function _HexByte(val)
	{
		val = Math.min(Math.max(Math.round(val), 0), 255);
		val = val.toString(16);
		return (val.length == 2) ? val : "0" + val;
	}
	
	
	// Convert Lab color into RGB color (both colors are represented as objects).
	function _LabToRGB(color)
	{
		var L = color.L*100 / FE.Configuration.fsWeights.L;
		var a = color.a*50 / FE.Configuration.fsWeights.a;
		var b = color.b*50 / FE.Configuration.fsWeights.b;
		
		// Convert to XYZ space first.
		var y = (L + 16.0) / 116.0;
		var x = a / 500.0 + y;
		var z = y - b / 200.0;

		x = (Math.pow(x, 3) > 0.008856) ? Math.pow(x, 3) : ((x - 16.0 / 116.0) / 7.787);
		y = (Math.pow(y, 3) > 0.008856) ? Math.pow(y, 3) : ((y - 16.0 / 116.0) / 7.787);
		z = (Math.pow(z, 3) > 0.008856) ? Math.pow(z, 3) : ((z - 16.0 / 116.0) / 7.787);

		// Mul by D65 color
		x *= 0.9505;
		z *= 1.0890;

		// Convert from XYZ to RGB
		var r = x * 3.2406 + y * -1.5372 + z * -0.4986;
		var g = x * -0.9689 + y * 1.8758 + z * 0.0415;
		var b = x * 0.0557 + y * -0.2040 + z * 1.0570;

		r = (r > 0.0031308) ? (1.055 * Math.pow(r, (1.0 / 2.4)) - 0.055) : (12.92 * r);
		g = (g > 0.0031308) ? (1.055 * Math.pow(g, (1.0 / 2.4)) - 0.055) : (12.92 * g);
		b = (b > 0.0031308) ? (1.055 * Math.pow(b, (1.0 / 2.4)) - 0.055) : (12.92 * b);

		// Convert to byte-clamped integers concatenated in hex string.
		return "#" + _HexByte(r * 255) + _HexByte(g * 255) + _HexByte(b * 255);			
	}
		
})(window.FE);
