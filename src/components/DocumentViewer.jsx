import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
    ArrowLeft,
    ChevronLeft,
    ChevronRight,
    Compass,
    Edit2,
    ZoomIn,
    ZoomOut,
    RotateCcw,
    Trash2,
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { getDocument, updateMetadata, metaDb } from '../db';
import GyroscopeWrapper from './GyroscopeWrapper';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const MIN_ZOOM = 0.75;
const MAX_ZOOM = 2.5;
const BASE_RENDER_SCALE = 1.5;
const HIGHLIGHT_COLOR = 'rgba(255, 235, 59, 0.4)';
const HIGHLIGHT_WIDTH = 15;

export default function DocumentViewer({ docId, onClose }) {
    const [pdfDoc, setPdfDoc] = useState(null);
    const [pageNum, setPageNum] = useState(1);
    const [numPages, setNumPages] = useState(0);
    const [meta, setMeta] = useState(null);
    const [gyroActive, setGyroActive] = useState(false);
    const [isHighlighting, setIsHighlighting] = useState(false);
    const [zoom, setZoom] = useState(1);
    const canvasRef = useRef(null);
    const drawCanvasRef = useRef(null);
    const [paths, setPaths] = useState([]);
    const isDrawing = useRef(false);
    const currentPath = useRef([]);
    const hasLoadedPathsRef = useRef(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');
    const [gyroError, setGyroError] = useState('');
    const [gyroSupported, setGyroSupported] = useState(false);

    const currentPagePaths = useMemo(
        () => paths.filter((path) => path.page === pageNum),
        [paths, pageNum],
    );

    useEffect(() => {
        const supported = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
        setGyroSupported(supported);
    }, []);

    useEffect(() => {
        let loadingTask = null;
        let active = true;
        hasLoadedPathsRef.current = false;
        setIsLoading(true);
        setError('');
        setPdfDoc(null);
        setMeta(null);
        setPaths([]);
        setNumPages(0);
        setPageNum(1);

        (async () => {
            try {
                const [data, metadata] = await Promise.all([
                    getDocument(docId),
                    metaDb.getItem(docId),
                ]);
                if (!data) {
                    throw new Error('Document not found in local storage.');
                }
                if (!active) return;

                loadingTask = pdfjsLib.getDocument({ data });
                const pdf = await loadingTask.promise;
                if (!active) return;

                const safeMeta = metadata ?? {
                    name: 'Untitled',
                    addedAt: Date.now(),
                    lastPage: 1,
                    paths: [],
                };
                const safePaths = Array.isArray(safeMeta.paths) ? safeMeta.paths : [];
                const storedPage = Number.isInteger(safeMeta.lastPage) ? safeMeta.lastPage : 1;
                const initialPage = Math.min(Math.max(storedPage, 1), pdf.numPages);

                setPdfDoc(pdf);
                setNumPages(pdf.numPages);
                setMeta(safeMeta);
                setPaths(safePaths);
                setPageNum(initialPage);
            } catch (err) {
                console.error('Error loading PDF:', err);
                setError('Could not load this PDF file.');
            } finally {
                if (active) {
                    setIsLoading(false);
                }
            }
        })();

        return () => {
            active = false;
            if (loadingTask) {
                loadingTask.destroy();
            }
        };
    }, [docId]);

    const redrawPaths = useCallback((pagePaths) => {
        const drawCanvas = drawCanvasRef.current;
        if (!drawCanvas) return;

        const ctx = drawCanvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        pagePaths.forEach((path) => {
            if (!Array.isArray(path.points) || path.points.length === 0) return;
            ctx.beginPath();
            ctx.strokeStyle = path.color ?? HIGHLIGHT_COLOR;
            ctx.lineWidth = path.width ?? HIGHLIGHT_WIDTH;
            ctx.moveTo(path.points[0].x, path.points[0].y);
            for (let i = 1; i < path.points.length; i++) {
                ctx.lineTo(path.points[i].x, path.points[i].y);
            }
            ctx.stroke();
        });
    }, []);

    useEffect(() => {
        if (!pdfDoc || !canvasRef.current || !drawCanvasRef.current) return;

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
            } catch (err) {
                if (err.name !== 'RenderingCancelledException') {
                    console.error('Error rendering page:', err);
                    setError('Could not render this page.');
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
    }, [pdfDoc, pageNum, zoom]);

    useEffect(() => {
        if (docId && pdfDoc) {
            updateMetadata(docId, { lastPage: pageNum }).catch((err) => {
                console.error('Failed to save reading position:', err);
            });
        }
    }, [pageNum, docId, pdfDoc]);

    useEffect(() => {
        redrawPaths(currentPagePaths);
    }, [currentPagePaths, redrawPaths]);

    useEffect(() => {
        if (!docId || !meta) return;

        if (!hasLoadedPathsRef.current) {
            hasLoadedPathsRef.current = true;
            return;
        }

        updateMetadata(docId, { paths }).catch((err) => {
            console.error('Failed to save annotations:', err);
        });
    }, [paths, docId, meta]);

    const getCanvasPoint = useCallback((event) => {
        const canvas = drawCanvasRef.current;
        if (!canvas) return null;

        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;

        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;

        return {
            x: (event.clientX - rect.left) * scaleX,
            y: (event.clientY - rect.top) * scaleY,
        };
    }, []);

    const handlePointerDown = (e) => {
        if (!isHighlighting || !drawCanvasRef.current) return;

        const point = getCanvasPoint(e);
        if (!point) return;

        isDrawing.current = true;
        drawCanvasRef.current.setPointerCapture(e.pointerId);
        currentPath.current = [point];

        const ctx = drawCanvasRef.current.getContext('2d');
        if (!ctx) return;
        ctx.beginPath();
        ctx.moveTo(point.x, point.y);
    };

    const handlePointerMove = (e) => {
        if (!isDrawing.current || !isHighlighting || !drawCanvasRef.current) return;

        const point = getCanvasPoint(e);
        if (!point) return;
        currentPath.current.push(point);

        const ctx = drawCanvasRef.current.getContext('2d');
        if (!ctx) return;
        ctx.strokeStyle = HIGHLIGHT_COLOR;
        ctx.lineWidth = HIGHLIGHT_WIDTH;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
    };

    const handlePointerUp = (e) => {
        if (!isDrawing.current || !isHighlighting || !drawCanvasRef.current) return;

        isDrawing.current = false;
        try {
            drawCanvasRef.current.releasePointerCapture(e.pointerId);
        } catch {
            // Ignore if capture is already released.
        }

        const nextPathPoints = currentPath.current;
        currentPath.current = [];

        const ctx = drawCanvasRef.current.getContext('2d');
        if (ctx) ctx.beginPath();

        if (nextPathPoints.length > 1) {
            const newPath = {
                page: pageNum,
                color: HIGHLIGHT_COLOR,
                width: HIGHLIGHT_WIDTH,
                points: nextPathPoints,
            };
            setPaths((prev) => [...prev, newPath]);
        }
    };

    const changePage = (offset) => {
        setPageNum((prev) => {
            const newPage = prev + offset;
            if (newPage < 1) return 1;
            if (newPage > numPages) return numPages;
            return newPage;
        });
    };

    const changeZoom = (offset) => {
        setZoom((prev) => {
            const nextZoom = prev + offset;
            const clampedZoom = Math.min(Math.max(nextZoom, MIN_ZOOM), MAX_ZOOM);
            return Number(clampedZoom.toFixed(2));
        });
    };

    const clearCurrentPageHighlights = () => {
        setPaths((prev) => prev.filter((path) => path.page !== pageNum));
    };

    const toggleGyroscope = async () => {
        if (gyroActive) {
            setGyroActive(false);
            setGyroError('');
            return;
        }

        if (!gyroSupported) {
            setGyroError('Gyroscope is not supported on this device/browser.');
            return;
        }

        if (!window.isSecureContext) {
            setGyroError('Gyroscope requires HTTPS or localhost.');
            return;
        }

        const orientationEvent = window.DeviceOrientationEvent;
        if (orientationEvent && typeof orientationEvent.requestPermission === 'function') {
            try {
                const permission = await orientationEvent.requestPermission();
                if (permission !== 'granted') {
                    setGyroError('Gyroscope permission was denied.');
                    return;
                }
            } catch (err) {
                console.error('Gyro permission error:', err);
                setGyroError('Unable to enable gyroscope permission.');
                return;
            }
        }

        setGyroError('');
        setGyroActive(true);
    };

    return (
        <div className="viewer-container">
            <div className="viewer-header glass">
                <div className="header-left">
                    <button type="button" onClick={onClose} aria-label="Back to library">
                        <ArrowLeft size={24} />
                    </button>
                    <span className="doc-title">{meta ? meta.name : 'Loading...'}</span>
                </div>
                <div className="header-right">
                    <button
                        type="button"
                        onClick={() => setIsHighlighting((prev) => !prev)}
                        className={isHighlighting ? 'gyro-active' : ''}
                        aria-label="Toggle highlighter"
                        title="Toggle highlighter"
                    >
                        <Edit2 size={24} />
                    </button>
                    <button
                        type="button"
                        onClick={clearCurrentPageHighlights}
                        disabled={currentPagePaths.length === 0}
                        aria-label="Clear highlights on this page"
                        title="Clear highlights on this page"
                    >
                        <Trash2 size={20} />
                    </button>
                    <button
                        type="button"
                        onClick={toggleGyroscope}
                        className={gyroActive ? 'gyro-active' : ''}
                        aria-label="Toggle gyroscope"
                        title="Toggle gyroscope"
                    >
                        <Compass size={24} />
                    </button>
                    <button type="button" onClick={() => changeZoom(-0.1)} aria-label="Zoom out" title="Zoom out">
                        <ZoomOut size={20} />
                    </button>
                    <button type="button" onClick={() => setZoom(1)} aria-label="Reset zoom" title="Reset zoom">
                        <RotateCcw size={20} />
                    </button>
                    <button type="button" onClick={() => changeZoom(0.1)} aria-label="Zoom in" title="Zoom in">
                        <ZoomIn size={20} />
                    </button>
                </div>
            </div>
            {gyroError ? <div className="gyro-status">{gyroError}</div> : null}

            <div
                className="pdf-canvas-container"
                style={{
                    overflow: gyroActive ? 'hidden' : 'auto',
                    touchAction: isHighlighting ? 'none' : 'pan-y',
                }}
            >
                {isLoading ? (
                    <p className="viewer-message">Loading PDF...</p>
                ) : error ? (
                    <p className="viewer-message viewer-error">{error}</p>
                ) : (
                    <GyroscopeWrapper isActive={gyroActive}>
                        <div style={{ position: 'relative' }}>
                            <canvas ref={canvasRef} />
                            <canvas
                                ref={drawCanvasRef}
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    zIndex: 10,
                                    pointerEvents: isHighlighting ? 'auto' : 'none',
                                }}
                                onPointerDown={handlePointerDown}
                                onPointerMove={handlePointerMove}
                                onPointerUp={handlePointerUp}
                                onPointerCancel={handlePointerUp}
                                onPointerLeave={handlePointerUp}
                            />
                        </div>
                    </GyroscopeWrapper>
                )}
            </div>

            <div className="bottom-bar glass">
                <button type="button" onClick={() => changePage(-1)} disabled={pageNum <= 1}>
                    <ChevronLeft size={28} />
                </button>
                <span>{pageNum} / {numPages || '-'}</span>
                <span>{Math.round(zoom * 100)}%</span>
                <button type="button" onClick={() => changePage(1)} disabled={pageNum >= numPages}>
                    <ChevronRight size={28} />
                </button>
            </div>
        </div>
    );
}
