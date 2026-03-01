import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
    ArrowLeft,
    ChevronLeft,
    ChevronRight,
    Compass,
    Edit2,
    PenTool,
    Eraser,
    Trash2,
    Layers,
    BookOpen
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { getDocument, updateMetadata, metaDb } from '../db';
import GyroscopeWrapper from './GyroscopeWrapper';
import PageRenderer from './PageRenderer';
import { FileOpener } from '@capacitor-community/file-opener';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const MIN_ZOOM = 0.75;
const MAX_ZOOM = 2.5;

function base64FromBuffer(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

export default function DocumentViewer({ docId, onClose }) {
    const [pdfDoc, setPdfDoc] = useState(null);
    const [pageNum, setPageNum] = useState(1);
    const [numPages, setNumPages] = useState(0);
    const [meta, setMeta] = useState(null);

    // View Tools
    const [gyroActive, setGyroActive] = useState(false);
    const [zoom, setZoom] = useState(1);
    const [viewMode, setViewMode] = useState('swipe'); // 'swipe' or 'scroll'

    // Drawing Tools
    const [drawMode, setDrawMode] = useState(null); // 'highlight', 'pen', 'pencil', 'eraser', null
    const [drawColor, setDrawColor] = useState('rgba(255, 235, 59, 0.4)');

    const [paths, setPaths] = useState([]);
    const hasLoadedPathsRef = useRef(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');
    const [gyroError, setGyroError] = useState('');
    const [gyroSupported, setGyroSupported] = useState(false);

    const onPathAdd = useCallback((newPath) => {
        setPaths(prev => [...prev, newPath]);
    }, []);

    const onPathRemove = useCallback((pageNumToSearch, indexInPage) => {
        setPaths(prev => {
            const newPaths = [...prev];
            // Find finding nth path of this page
            let count = -1;
            for (let i = 0; i < newPaths.length; i++) {
                if (newPaths[i].page === pageNumToSearch) {
                    count++;
                    if (count === indexInPage) {
                        newPaths.splice(i, 1);
                        break;
                    }
                }
            }
            return newPaths;
        });
    }, []);

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

                // If the file is not a PDF, try to open natively
                if (metadata && metadata.name) {
                    const ext = metadata.name.split('.').pop().toLowerCase();
                    if (['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls'].includes(ext)) {
                        if (Capacitor.isNativePlatform()) {
                            try {
                                const base64Data = base64FromBuffer(data);
                                const path = `${metadata.name}`;

                                const result = await Filesystem.writeFile({
                                    path,
                                    data: base64Data,
                                    directory: Directory.Cache
                                });

                                await FileOpener.open({
                                    filePath: result.uri,
                                    contentType: ext === 'docx' || ext === 'doc' ? 'application/msword' :
                                        ext === 'pptx' || ext === 'ppt' ? 'application/vnd.ms-powerpoint' :
                                            'application/vnd.ms-excel'
                                });
                            } catch (err) {
                                console.error("Native open failed:", err);
                                alert("Failed to open document on this device.");
                            }
                        } else {
                            alert(`Viewing ${ext.toUpperCase()} files is only supported on the mobile app.`);
                        }
                        onClose();
                        return;
                    }
                }

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

    useEffect(() => {
        if (docId && pdfDoc) {
            updateMetadata(docId, { lastPage: pageNum }).catch((err) => {
                console.error('Failed to save reading position:', err);
            });
        }
    }, [pageNum, docId, pdfDoc]);

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

    // Pinch to Zoom & Swipe gestures
    const initialPinchDist = useRef(null);
    const initialZoom = useRef(1);
    const touchStartX = useRef(null);
    const touchStartY = useRef(null);
    const [visualScale, setVisualScale] = useState(1);
    const [visualOrigin, setVisualOrigin] = useState('center center');

    const handleTouchStart = (e) => {
        if (e.touches.length === 2 && !drawMode) {
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            initialPinchDist.current = dist;
            initialZoom.current = zoom;

            // Calculate center of pinch to use as transform origin
            const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            setVisualOrigin(`${centerX}px ${centerY}px`);
        } else if (e.touches.length === 1 && viewMode === 'swipe' && !drawMode && zoom <= 1.1) {
            touchStartX.current = e.touches[0].clientX;
            touchStartY.current = e.touches[0].clientY;
        } else {
            touchStartX.current = null;
            touchStartY.current = null;
        }
    };

    const handleTouchMove = (e) => {
        if (e.touches.length === 2 && initialPinchDist.current && !drawMode) {
            e.preventDefault(); // prevent scroll
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            const scale = dist / initialPinchDist.current;
            const nextZoom = initialZoom.current * scale;
            const clampedZoom = Math.min(Math.max(nextZoom, MIN_ZOOM), MAX_ZOOM);
            setVisualScale(clampedZoom / initialZoom.current);
        }
    };

    const handleTouchEnd = (e) => {
        if (initialPinchDist.current) {
            const finalZoom = Number((initialZoom.current * visualScale).toFixed(2));
            setZoom(finalZoom);
            setVisualScale(1);
            initialPinchDist.current = null;
        }

        if (touchStartX.current && viewMode === 'swipe' && !drawMode && zoom <= 1.1) {
            if (e.changedTouches.length === 0) return;
            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;
            const dx = touchStartX.current - touchEndX;
            const dy = touchStartY.current - touchEndY;

            if (Math.abs(dx) > 60 && Math.abs(dy) < 60) {
                if (dx > 0) changePage(1);
                else changePage(-1);
            }
        }
        touchStartX.current = null;
        touchStartY.current = null;
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
        setPaths((prev) => prev.filter((path) => viewMode === 'swipe' ? path.page !== pageNum : true));
        if (viewMode === 'scroll') {
            if (window.confirm("Clear all paths from all pages?")) {
                setPaths([]);
            }
        }
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
        <div className="viewer-container" style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw' }}>
            <div className="viewer-header glass">
                <div className="header-left">
                    <button type="button" onClick={onClose} aria-label="Back to library">
                        <ArrowLeft size={24} />
                    </button>
                    <span className="doc-title">{meta ? meta.name : 'Loading...'}</span>
                </div>
                <div className="header-right">
                    <div className="mode-toggle">
                        <button
                            className={`mode-toggle-btn ${viewMode === 'swipe' ? 'active' : ''}`}
                            onClick={() => setViewMode('swipe')}
                        >
                            <BookOpen size={16} style={{ marginRight: '4px' }} /> Swipe
                        </button>
                        <button
                            className={`mode-toggle-btn ${viewMode === 'scroll' ? 'active' : ''}`}
                            onClick={() => setViewMode('scroll')}
                        >
                            <Layers size={16} style={{ marginRight: '4px' }} /> Scroll
                        </button>
                    </div>
                </div>
            </div>

            <div className="toolbar-panel glass">
                <div className="toolbar-group">
                    <button
                        type="button"
                        onClick={() => setDrawMode(prev => prev === 'highlight' ? null : 'highlight')}
                        className={`tool-btn ${drawMode === 'highlight' ? 'active' : ''}`}
                        title="Highlighter"
                    >
                        <Edit2 size={20} />
                    </button>
                    <button
                        type="button"
                        onClick={() => setDrawMode(prev => prev === 'pen' ? null : 'pen')}
                        className={`tool-btn ${drawMode === 'pen' ? 'active' : ''}`}
                        title="Pen"
                    >
                        <PenTool size={20} />
                    </button>
                    <button
                        type="button"
                        onClick={() => setDrawMode(prev => prev === 'pencil' ? null : 'pencil')}
                        className={`tool-btn ${drawMode === 'pencil' ? 'active' : ''}`}
                        title="Pencil"
                    >
                        <Edit2 size={20} strokeWidth={1} style={{ transform: 'scale(0.8)' }} />
                    </button>
                    <button
                        type="button"
                        onClick={() => setDrawMode(prev => prev === 'eraser' ? null : 'eraser')}
                        className={`tool-btn ${drawMode === 'eraser' ? 'active' : ''}`}
                        title="Eraser"
                    >
                        <Eraser size={20} />
                    </button>
                </div>

                {(drawMode === 'highlight' || drawMode === 'pen' || drawMode === 'pencil') && (
                    <div className="toolbar-group">
                        {['rgba(255, 235, 59, 0.4)', 'rgba(244, 67, 54, 0.6)', 'rgba(33, 150, 243, 0.6)', 'rgba(76, 175, 80, 0.6)', '#000000', '#ffffff'].map(color => (
                            <button
                                key={color}
                                className={`color-btn ${drawColor === color ? 'active' : ''}`}
                                style={{ backgroundColor: color.replace('0.4)', '1)').replace('0.6)', '1)') }}
                                onClick={() => setDrawColor(color)}
                            />
                        ))}
                    </div>
                )}

                <div className="toolbar-group">
                    <button
                        type="button"
                        onClick={clearCurrentPageHighlights}
                        className="tool-btn"
                        title={viewMode === 'swipe' ? "Clear highlights on this page" : "Clear all highlights"}
                    >
                        <Trash2 size={20} />
                    </button>
                </div>

                <div className="toolbar-group" style={{ marginLeft: 'auto', borderRight: 'none' }}>
                    <button
                        type="button"
                        onClick={toggleGyroscope}
                        className={`tool-btn ${gyroActive ? 'active' : ''}`}
                        title="Toggle gyroscope"
                    >
                        <Compass size={20} />
                    </button>
                </div>
            </div>
            {gyroError ? <div className="gyro-status">{gyroError}</div> : null}

            <div
                className="pdf-canvas-container"
                style={{
                    flex: 1,
                    overflow: viewMode === 'scroll' ? 'hidden' : 'hidden', // Scroll handled internally or by wrapper
                    position: 'relative'
                }}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onTouchCancel={handleTouchEnd}
            >
                {isLoading ? (
                    <p className="viewer-message">Loading PDF...</p>
                ) : error ? (
                    <p className="viewer-message viewer-error">{error}</p>
                ) : (
                    <GyroscopeWrapper isActive={gyroActive}>
                        {viewMode === 'scroll' ? (
                            <div className="scroll-container" style={{
                                margin: 0,
                                transform: `scale(${visualScale})`,
                                transformOrigin: visualOrigin,
                                transition: visualScale === 1 ? 'transform 0.1s ease-out' : 'none'
                            }}>
                                {Array.from({ length: numPages }).map((_, i) => (
                                    <PageRenderer
                                        key={`page-${i + 1}`}
                                        pdfDoc={pdfDoc}
                                        pageNum={i + 1}
                                        zoom={zoom}
                                        paths={paths.filter((p) => p.page === i + 1)}
                                        onPathAdd={onPathAdd}
                                        onPathRemove={(idx) => onPathRemove(i + 1, idx)}
                                        drawMode={drawMode}
                                        drawColor={drawColor}
                                        lazyLoad={true}
                                    />
                                ))}
                            </div>
                        ) : (
                            <div style={{
                                display: 'flex',
                                justifyContent: 'center',
                                alignItems: 'center',
                                width: '100%',
                                height: '100%',
                                transform: `scale(${visualScale})`,
                                transformOrigin: visualOrigin,
                                transition: visualScale === 1 ? 'transform 0.1s ease-out' : 'none'
                            }}>
                                <PageRenderer
                                    pdfDoc={pdfDoc}
                                    pageNum={pageNum}
                                    zoom={zoom}
                                    paths={paths.filter((p) => p.page === pageNum)}
                                    onPathAdd={onPathAdd}
                                    onPathRemove={(idx) => onPathRemove(pageNum, idx)}
                                    drawMode={drawMode}
                                    drawColor={drawColor}
                                    lazyLoad={false}
                                />
                            </div>
                        )}
                    </GyroscopeWrapper>
                )}
            </div>

            {viewMode === 'swipe' && (
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
            )}
        </div>
    );
}
