import { useState } from 'react';
import Library from './components/Library';
import DocumentViewer from './components/DocumentViewer';
import './App.css';

function App() {
  const [currentDocId, setCurrentDocId] = useState(null);

  // If a doc is selected, show viewer, else library
  return (
    <div className="app-container">
      {currentDocId ? (
        <DocumentViewer
          docId={currentDocId}
          onClose={() => setCurrentDocId(null)}
        />
      ) : (
        <Library onOpenDoc={setCurrentDocId} />
      )}
    </div>
  );
}

export default App;
