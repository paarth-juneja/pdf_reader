import { useEffect, useRef } from 'react';

export default function GyroscopeWrapper({ children, isActive }) {
    const wrapperRef = useRef(null);
    const frameRef = useRef(null);
    const currentOffsetRef = useRef({ x: 0, y: 0 });
    const targetOffsetRef = useRef({ x: 0, y: 0 });

    useEffect(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper) return undefined;

        const resetTransform = () => {
            targetOffsetRef.current = { x: 0, y: 0 };
            currentOffsetRef.current = { x: 0, y: 0 };
            wrapper.style.transform = 'translate3d(0px, 0px, 0px)';
        };

        if (!isActive) {
            resetTransform();
            return undefined;
        }

        let baselineBeta = null;
        let baselineGamma = null;
        const MAX_SHIFT = 80;
        const SENSITIVITY = 2.1;
        const DEAD_ZONE = 1.2;
        const SMOOTHING = 0.22;

        const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

        const handleOrientation = (event) => {
            if (event.beta === null || event.gamma === null) return;

            if (baselineBeta === null || baselineGamma === null) {
                baselineBeta = event.beta;
                baselineGamma = event.gamma;
            }

            let deltaBeta = event.beta - baselineBeta;
            let deltaGamma = event.gamma - baselineGamma;

            if (Math.abs(deltaBeta) < DEAD_ZONE) deltaBeta = 0;
            if (Math.abs(deltaGamma) < DEAD_ZONE) deltaGamma = 0;

            const moveY = clamp(deltaBeta * SENSITIVITY, -MAX_SHIFT, MAX_SHIFT);
            const moveX = clamp(deltaGamma * SENSITIVITY, -MAX_SHIFT, MAX_SHIFT);

            targetOffsetRef.current = { x: -moveX, y: -moveY };
        };

        const animate = () => {
            const current = currentOffsetRef.current;
            const target = targetOffsetRef.current;

            current.x += (target.x - current.x) * SMOOTHING;
            current.y += (target.y - current.y) * SMOOTHING;
            currentOffsetRef.current = current;

            wrapper.style.transform = `translate3d(${current.x.toFixed(2)}px, ${current.y.toFixed(2)}px, 0px)`;
            frameRef.current = window.requestAnimationFrame(animate);
        };

        frameRef.current = window.requestAnimationFrame(animate);
        window.addEventListener('deviceorientation', handleOrientation, true);

        return () => {
            window.removeEventListener('deviceorientation', handleOrientation, true);
            if (frameRef.current) {
                window.cancelAnimationFrame(frameRef.current);
            }
            resetTransform();
        };
    }, [isActive]);

    return (
        <div
            ref={wrapperRef}
            style={{
                willChange: 'transform',
                width: '100%',
                height: '100%',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
            }}
        >
            {children}
        </div>
    );
}
