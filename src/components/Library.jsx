import { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, FileText, Trash2 } from 'lucide-react';
import { saveDocument, getDocumentsList, deleteDocument } from '../db';

export default function Library({ onOpenDoc }) {
    const [docs, setDocs] = useState([]);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState('');
    const fileInputRef = useRef(null);

    const loadDocs = useCallback(async () => {
        const list = await getDocumentsList();
        setDocs(list);
    }, []);

    useEffect(() => {
        loadDocs();
    }, [loadDocs]);

    const handleUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        setError('');

        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
        if (!isPdf) {
            setError('Please choose a valid PDF file.');
            e.target.value = '';
            return;
        }

        try {
            setIsSaving(true);
            const id = `${Date.now()}-${file.name}`;
            const arrayBuffer = await file.arrayBuffer();

            await saveDocument(id, arrayBuffer, file.name);
            await loadDocs();
        } catch (err) {
            console.error('Failed to save PDF:', err);
            setError('Unable to save this file. Please try again.');
        } finally {
            setIsSaving(false);
            e.target.value = '';
        }
    };

    const handleDelete = async (docId) => {
        try {
            await deleteDocument(docId);
            await loadDocs();
        } catch (err) {
            console.error('Failed to delete document:', err);
            setError('Unable to delete this document right now.');
        }
    };

    return (
        <div className="library-container">
            <div className="library-header">
                <h1>Library</h1>
                <button
                    className="add-btn"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isSaving}
                >
                    <Plus size={20} />
                    {isSaving ? 'Saving...' : 'Add PDF'}
                </button>
                <input
                    type="file"
                    accept="application/pdf"
                    ref={fileInputRef}
                    style={{ display: 'none' }}
                    onChange={handleUpload}
                />
            </div>
            {error ? (
                <p style={{ color: '#ff8a80', marginBottom: '1rem' }}>{error}</p>
            ) : null}

            {docs.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: '4rem' }}>
                    <FileText size={64} style={{ opacity: 0.2, marginBottom: '1rem' }} />
                    <p>Your library is empty. Add a PDF to get started.</p>
                </div>
            ) : (
                <div className="doc-grid">
                    {docs.map(doc => (
                        <div
                            key={doc.id}
                            className="doc-card"
                            onClick={() => onOpenDoc(doc.id)}
                        >
                            <FileText size={40} className="doc-icon" />
                            <h3>{doc.name}</h3>
                            <p>Page {doc.lastPage || 1}</p>
                            <p style={{ fontSize: '0.7rem', marginTop: '0.5rem' }}>
                                {new Date(doc.addedAt).toLocaleDateString()}
                            </p>
                            <button
                                type="button"
                                aria-label="Delete document"
                                title="Delete document"
                                className="delete-doc-btn"
                                onClick={async (event) => {
                                    event.stopPropagation();
                                    await handleDelete(doc.id);
                                }}
                            >
                                <Trash2 size={16} />
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
