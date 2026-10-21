import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI } from '@google/genai';
import { 
  ArrowRight, Wind, Zap, ShieldCheck, Upload, CheckCircle, 
  ChevronDown, ChevronRight, Calculator, Bot, Activity, 
  Loader2, CheckCircle2, FileText, Share2, Award, Download, 
  ArrowLeft, Home, LayoutDashboard, User, Settings, LogOut, Server 
} from 'lucide-react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer 
} from 'recharts';

// --- FIREBASE IMPORTS ---
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, onSnapshot, updateDoc, increment } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

// --- FIREBASE CONFIG ---
const firebaseConfig = {
    apiKey: "AIzaSyC9YRhpugT6eIG0PY7O8EaPcB8re7SCoFA",
    authDomain: "turboflow-7b3ca.firebaseapp.com",
    projectId: "turboflow-7b3ca",
    storageBucket: "turboflow-7b3ca.firebasestorage.app",
    messagingSenderId: "659747979647",
    appId: "1:659747979647:web:e718597ad69cd2b7311a4a"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- SERVICES (AI & Simulation Status) ---
const SimulationStatus = {
  IDLE: 'IDLE', QUEUED: 'QUEUED', MESHING: 'MESHING', 
  RUNNING_CFD: 'RUNNING_CFD', POST_PROCESSING: 'POST_PROCESSING', 
  COMPLETED: 'COMPLETED', FAILED: 'FAILED'
};

const getAIAdvice = async (partName) => {
    const apiKey = localStorage.getItem('GEMINI_API_KEY');
    if (!apiKey) return "AI Key not set in localStorage.";
    try {
        const genAI = new GoogleGenAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(`Optimal parameter sweep for a race car ${partName}? Max 30 words.`);
        return result.response.text();
    } catch (e) { return "AI guidance unavailable."; }
};

// --- MAIN APP COMPONENT ---
const App = () => {
  const [currentView, setCurrentView] = useState('home');
  const [activeJob, setActiveJob] = useState(null);
  const [user, setUser] = useState(null);
  const [credits, setCredits] = useState(0);

  // 1. Listen for Auth Changes & Real-time Credits
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        const userRef = doc(db, "users", currentUser.uid);
        // Real-time listener: Website updates instantly if credits change in Firebase Console
        const unsubCredits = onSnapshot(userRef, (snap) => {
          if (snap.exists()) setCredits(snap.data().credits);
        });
        return () => unsubCredits();
      } else {
        setCredits(0);
      }
    });
    return () => unsubscribe();
  }, []);

  // 2. Real Login Logic
  const loginWithGoogle = async () => {
    const provider = new GoogleAuthProvider();
    try {
      const result = await signInWithPopup(auth, provider);
      const userRef = doc(db, "users", result.user.uid);
      const userSnap = await getDoc(userRef);

      if (!userSnap.exists()) {
        await setDoc(userRef, {
          email: result.user.email,
          displayName: result.user.displayName,
          credits: 500, // Starter Gift
          createdAt: new Date()
        });
      }
    } catch (error) { console.error(error); }
  };

  // 3. Real Credit Deduction Logic
  const startSimulation = async (config, cost, file) => {
    if (!user) return loginWithGoogle();
    if (credits < cost) return alert("Not enough credits!");

    // Deduct from Firestore
    const userRef = doc(db, "users", user.uid);
    await updateDoc(userRef, { credits: increment(-cost) });

    const newJob = {
      id: Math.random().toString(36).substr(2, 6).toUpperCase(),
      name: file ? file.name : `Sim-${config.partType}`,
      status: SimulationStatus.QUEUED,
      progress: 0,
      config: config
    };

    setActiveJob(newJob);
    setCurrentView('dashboard');
  };

  // 4. Mock Simulation Progress Logic
  useEffect(() => {
    if (!activeJob || activeJob.status === SimulationStatus.COMPLETED) return;
    const interval = setInterval(() => {
      setActiveJob(prev => {
        if (!prev || prev.progress >= 100) {
            clearInterval(interval);
            return prev ? { ...prev, status: SimulationStatus.COMPLETED, progress: 100 } : null;
        }
        return { ...prev, progress: prev.progress + 5, status: prev.progress > 50 ? SimulationStatus.RUNNING_CFD : SimulationStatus.MESHING };
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [activeJob?.id]);

  return (
    <div className="min-h-screen bg-carbon-950 text-white flex">
      {/* Sidebar */}
      <aside className="w-64 border-r border-gray-800 bg-carbon-900/30 flex flex-col h-screen sticky top-0">
        <div className="p-6 border-b border-gray-800 flex items-center gap-3">
          <img src="logo.png" alt="TurboFlow" style={{width:32,height:32,objectFit:'cover',borderRadius:8}} onError={(e)=>{e.target.style.display='none'}} />
          <span className="font-bold text-xl">TurboFlow</span>
        </div>
        
        <nav className="flex-1 p-4 space-y-2">
          <button onClick={() => setCurrentView('home')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl ${currentView === 'home' ? 'bg-aeroblue-600/20 text-aeroblue-400' : 'text-gray-400'}`}>
            <Home size={18} /> Home
          </button>
          <button onClick={() => activeJob ? setCurrentView('dashboard') : setCurrentView('wizard')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl ${currentView === 'dashboard' ? 'bg-aeroblue-600/20 text-aeroblue-400' : 'text-gray-400'}`}>
            <LayoutDashboard size={18} /> Simulation
          </button>
        </nav>

        {/* User Profile Section */}
        <div className="p-4 border-t border-gray-800">
          {user ? (
            <div className="flex items-center gap-3 p-2 bg-carbon-900 rounded-lg">
              <img src={user.photoURL} className="w-8 h-8 rounded-full border border-aeroblue-500" />
              <div className="flex-1 overflow-hidden">
                <p className="text-xs font-bold truncate">{user.displayName}</p>
                <p className="text-[10px] text-aeroblue-400 font-mono font-bold">{credits} CREDITS</p>
              </div>
              <LogOut size={14} onClick={() => signOut(auth)} className="cursor-pointer hover:text-red-400" />
            </div>
          ) : (
            <button onClick={loginWithGoogle} className="btn-google w-full py-2 text-xs">
               Sign In with Google
            </button>
          )}
        </div>
      </aside>

      {/* Main View Manager */}
      <main className="flex-1">
        {currentView === 'home' && <HeroView onStart={() => user ? setCurrentView('wizard') : loginWithGoogle()} />}
        {currentView === 'wizard' && <WizardView onComplete={startSimulation} />}
        {currentView === 'dashboard' && <DashboardView job={activeJob} />}
      </main>
    </div>
  );
};

// --- MINI VIEW COMPONENTS ---
const HeroView = ({ onStart }) => (
    <div className="p-20 text-center">
        <h1 className="text-6xl font-extrabold mb-6">Validate Design <br/><span className="text-aeroblue-400">In Parallel.</span></h1>
        <p className="text-gray-400 max-w-xl mx-auto mb-10 text-lg">Automated CFD for student race teams. Sign in to run 500 free credits worth of simulations.</p>
        <button onClick={onStart} className="px-10 py-4 bg-aeroblue-600 rounded-xl font-bold flex items-center gap-3 mx-auto hover:bg-aeroblue-500 transition-all">
            Start New Simulation <ArrowRight size={20}/>
        </button>
    </div>
);

const WizardView = ({ onComplete }) => {
  const [advice, setAdvice] = useState("Loading AI Guidance...");
  const [showConfirm, setShowConfirm] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(typeof localStorage !== 'undefined' && localStorage.getItem('suppressSubmitWarning') === '1');
  useEffect(() => { getAIAdvice("Front Wing").then(setAdvice); }, []);

  const handleSubmitClick = () => {
    if (dontAskAgain) {
      onComplete({partType: 'Front Wing'}, 250, null);
      return;
    }
    setShowConfirm(true);
  };

  const confirmAndContinue = () => {
    if (typeof localStorage !== 'undefined' && dontAskAgain) localStorage.setItem('suppressSubmitWarning','1');
    setShowConfirm(false);
    onComplete({partType: 'Front Wing'}, 250, null);
  };

  return (
    <div className="p-12 max-w-4xl mx-auto">
      <h2 className="text-3xl font-bold mb-8">Simulation Wizard</h2>
      <div className="bg-carbon-900 p-8 rounded-2xl border border-gray-800">
        <div className="flex gap-4 p-4 bg-indigo-900/20 border border-indigo-500/30 rounded-xl mb-8">
          <Bot className="text-indigo-400" />
          <div>
            <p className="text-xs font-bold text-indigo-400 uppercase">AI Strategy</p>
            <p className="text-sm text-gray-300">{advice}</p>
          </div>
        </div>
        <button onClick={handleSubmitClick} className="w-full py-4 bg-aeroblue-600 rounded-xl font-bold">
          Submit
        </button>
      </div>

      {showConfirm && (
        <div style={{position:'fixed',inset:0,display:'flex',alignItems:'center',justifyContent:'center',zIndex:300}}>
          <div style={{background:'#0b1220',padding:24,borderRadius:12,border:'1px solid #1f2a3a',width:420}}>
            <h3 style={{color:'#fff',marginBottom:8}}>Confirm Submission</h3>
            <p style={{color:'#9ca3af',fontSize:13,marginBottom:12}}>This will deduct 250 credits from your account. Do you want to continue?</p>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
              <input id="wizDontAsk" type="checkbox" checked={dontAskAgain} onChange={(e)=>setDontAskAgain(e.target.checked)} />
              <label htmlFor="wizDontAsk" style={{color:'#cbd5e1',fontSize:13}}>Don't show this again</label>
            </div>
            <div style={{display:'flex',justifyContent:'flex-end',gap:8}}>
              <button onClick={()=>setShowConfirm(false)} style={{padding:'8px 12px',background:'transparent',border:'1px solid #334155',color:'#cbd5e1',borderRadius:8}}>Cancel</button>
              <button onClick={confirmAndContinue} style={{padding:'8px 12px',background:'#2563eb',borderRadius:8,color:'#fff',border:'none'}}>Continue & Deduct</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const DashboardView = ({ job }) => (
    <div className="p-12 text-center">
        <h2 className="text-3xl font-bold mb-4">Job Status: {job?.status}</h2>
        <div className="w-full bg-gray-800 rounded-full h-4 mb-8 overflow-hidden">
            <div className="bg-aeroblue-500 h-full transition-all duration-500" style={{width: `${job?.progress}%`}}></div>
        </div>
        <div className="text-gray-400 font-mono">ID: #{job?.id}</div>
    </div>
);

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);