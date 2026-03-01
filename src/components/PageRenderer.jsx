import { useEffect, useRef, useCallback, useState, memo } from 'react';

const BASE_RENDER_SCALE = 1.5;

function getCanvasPoint(event, canvas) {
    if (!canvas) return null;
    let clientX = event.clientX;
    let clientY = event.clientY;

    if (event.touches && event.touches.length > 0) {
        clientX = event.touches[0].clientX;
        clientY = event.touches[0].clientY;
    }

    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY,
    };
}

function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    let dx = x2 - x1;
    let dy = y2 - y1;
    if (dx === 0 && dy === 0) {
        return Math.hypot(px - x1, py - y1);
    }
    let t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function pathIntersects(newPoints, existingPoints, threshold = 15) {
    for (let i = 0; i < newPoints.length; i++) {
        const p = newPoints[i];
        for (let j = 0; j < existingPoints.length - 1; j++) {
            const ep1 = existingPoints[j];
            const ep2 = existingPoints[j + 1];
            if (pointToSegmentDistance(p.x, p.y, ep1.x, ep1.y, ep2.x, ep2.y) < threshold) {
                return true;
            }
        }
    }
    return false;
}

const PageRenderer = memo(function PageRenderer({
    pdfDoc,
    pageNum,
    zoom,
    paths, // All paths for this page
    onPathAdd,
    onPathRemove, // function(pathIndex)
    drawMode, // 'highlight', 'pen', 'pencil', 'eraser', null
    drawColor,
    lazyLoad = false, // false for swipe mode, true for scroll mode
}) {
    const wrapperRef = useRef(null);
    const canvasRef = useRef(null);
    const drawCanvasRef = useRef(null);
    const isDrawing = useRef(false);
    const currentPath = useRef([]);
    const [rendered, setRendered] = useState(false);
    const [isVisible, setIsVisible] = useState(!lazyLoad);

    useEffect(() => {
        if (!lazyLoad) return undefined;
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
                setIsVisible(true);
            }
        }, { rootMargin: '200% 0px' });

        if (wrapperRef.current) observer.observe(wrapperRef.current);
        return () => observer.disconnect();
    }, [lazyLoad]);

    useEffect(() => {
        if (!isVisible || !pdfDoc || !canvasRef.current || !drawCanvasRef.current) return;

        let renderTask = null;
        let active = true;

        const renderPage = async () => {
            try {
                const page = await pdfDoc.getPage(pageNum);
                if (!active) return;

                const viewport = page.getViewport({ scale: zoom * BASE_RENDER_SCALE });
                const canvas = canvasRef.current;
                const context = canvas.getContext('2d');
                if (!context) return;

                canvas.height = viewport.height;
                canvas.width = viewport.width;
                drawCanvasRef.current.width = viewport.width;
                drawCanvasRef.current.height = viewport.height;

                const renderContext = {
                    canvasContext: context,
                    viewport,
                };

                renderTask = page.render(renderContext);
                await renderTask.promise;

                if (active) {
                    setRendered(true);
                }
            } catch (err) {
                if (err.name !== 'RenderingCancelledException') {
                    console.error('Error rendering page:', err);
                }
            }
        };

        renderPage();

        return () => {
            active = false;
            if (renderTask) {
                renderTask.cancel();
            }
        };
    }, [pdfDoc, pageNum, zoom, isVisible]);

    const redrawPaths = useCallback(() => {
        const drawCanvas = drawCanvasRef.current;
        if (!drawCanvas) return;

        const ctx = drawCanvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        paths.forEach((path) => {
            if (!Array.isArray(path.points) || path.points.length === 0) return;
            ctx.beginPath();
            ctx.strokeStyle = path.color;
            ctx.lineWidth = path.width;
            if (path.globalAlpha !== undefined) {
                ctx.globalAlpha = path.globalAlpha;
            } else {
                ctx.globalAlpha = 1;
            }

            ctx.moveTo(path.points[0].x, path.points[0].y);
            for (let i = 1; i < path.points.length; i++) {
                ctx.lineTo(path.points[i].x, path.points[i].y);
            }
            ctx.stroke();
        });
        ctx.globalAlpha = 1; // reset
    }, [paths]);

    useEffect(() => {
        if (rendered) {
            redrawPaths();
        }
    }, [paths, rendered, redrawPaths]);

    const handlePointerDown = (e) => {
        if (!drawMode || !drawCanvasRef.current) return;

        // Prevent default only if it's touch, to stop scrolling when drawing
        if (e.type.includes('touch')) {
            e.preventDefault(); // Might not work with passive listeners, we use CSS touch-action: none
        }

        const point = getCanvasPoint(e, drawCanvasRef.current);
        if (!point) return;

        if (drawMode === 'eraser') {
            isDrawing.current = true;
            currentPath.current = [point];
            return;
        }

        isDrawing.current = true;

        try {
            if (e.pointerId !== undefined) {
                drawCanvasRef.current.setPointerCapture(e.pointerId);
            }
        } catch { }

        currentPath.current = [point];

        const ctx = drawCanvasRef.current.getContext('2d');
        if (!ctx) return;
        ctx.beginPath();
        ctx.moveTo(point.x, point.y);
    };

    const handlePointerMove = (e) => {
        if (!isDrawing.current || !drawMode || !drawCanvasRef.current) return;

        const point = getCanvasPoint(e, drawCanvasRef.current);
        if (!point) return;

        currentPath.current.push(point);

        if (drawMode === 'eraser') {
            // Find intersecting path and remove it
            const targetPaths = [...paths];
            for (let i = targetPaths.length - 1; i >= 0; i--) {
                const path = targetPaths[i];
                if (pathIntersects([point, currentPath.current[currentPath.current.length - 2] || point], path.points, path.width)) {
                    onPathRemove(i); // Tell parent to remove this path by index in this page's list
                    // It will trigger a re-render
                }
            }
            return;
        }

        const ctx = drawCanvasRef.current.getContext('2d');
        if (!ctx) return;

        let width = 3;
        let alpha = 1;

        if (drawMode === 'highlight') {
            width = 15;
            alpha = 0.4;
        } else if (drawMode === 'pencil') {
            width = 1.5;
        } else if (drawMode === 'pen') {
            width = 3;
        }

        ctx.strokeStyle = drawColor;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = alpha;

        ctx.lineTo(point.x, point.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
    };

    const handlePointerUp = (e) => {
        if (!isDrawing.current || !drawMode || !drawCanvasRef.current) return;

        isDrawing.current = false;
        try {
            if (e.pointerId !== undefined) {
                drawCanvasRef.current.releasePointerCapture(e.pointerId);
            }
        } catch { }

        const nextPathPoints = currentPath.current;
        currentPath.current = [];

        if (drawMode === 'eraser') return; // Eraser doesn't save paths

        const ctx = drawCanvasRef.current.getContext('2d');
        if (ctx) {
            ctx.beginPath();
        }

        if (nextPathPoints.length > 1) {
            let width = 3;
            let alpha = 1;

            if (drawMode === 'highlight') {
                width = 15;
                alpha = 0.4;
            } else if (drawMode === 'pencil') {
                width = 1.5;
            } else if (drawMode === 'pen') {
                width = 3;
            }

            const newPath = {
                page: pageNum,
                color: drawColor,
                width: width,
                globalAlpha: alpha,
                points: nextPathPoints,
            };
            onPathAdd(newPath);
        }
    };

    return (
        <div ref={wrapperRef} className="pdf-page-wrapper" style={{ position: 'relative', touchAction: drawMode ? 'none' : 'auto', minHeight: '50vh', minWidth: '50vw' }}>
            <canvas ref={canvasRef} style={{ display: 'block' }} />
            <canvas
                ref={drawCanvasRef}
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    zIndex: 10,
                    pointerEvents: drawMode ? 'auto' : 'none',
                    display: 'block'
                }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onPointerLeave={handlePointerUp}
                onTouchStart={handlePointerDown}
                onTouchMove={handlePointerMove}
                onTouchEnd={handlePointerUp}
                onTouchCancel={handlePointerUp}
            />
        </div>
    );
});

export default PageRenderer;
