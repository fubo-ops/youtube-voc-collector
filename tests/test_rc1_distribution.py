import json, subprocess, tempfile, unittest, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class Rc1DistributionTests(unittest.TestCase):
    def test_release_contract_files_exist(self):
        required = ['README.md','LICENSE','CHANGELOG.md','VERSION','SECURITY.md','.gitignore',
                    'install.ps1','install.cmd','doctor.ps1','uninstall.ps1','uninstall.cmd','build_release.ps1']
        self.assertFalse([name for name in required if not (ROOT/name).is_file()])
        self.assertEqual((ROOT/'VERSION').read_text(encoding='utf-8').strip(),'1.0.0-rc1')

    def test_powershell_entrypoints_parse(self):
        for name in ('install.ps1','doctor.ps1','uninstall.ps1','build_release.ps1'):
            path=ROOT/name
            run=subprocess.run(['powershell','-NoProfile','-Command',f"[void][scriptblock]::Create((Get-Content -Raw -LiteralPath '{path}'))"],capture_output=True,text=True)
            self.assertEqual(run.returncode,0,run.stderr)

    def test_release_zip_has_no_sensitive_or_runtime_data(self):
        build=ROOT/'build_release.ps1'
        self.assertTrue(build.is_file())
        run=subprocess.run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',str(build)],capture_output=True,text=True)
        self.assertEqual(run.returncode,0,run.stderr)
        archive=ROOT/'dist/youtube-voc-collector-1.0.0-rc1.zip'
        with zipfile.ZipFile(archive) as z:
            names=[n.lower() for n in z.namelist()]
        banned=('outputs/','profile','cookie','token','.pem','.key','__pycache__','.pyc','.log')
        self.assertFalse([n for n in names if any(x in n for x in banned)])

    def test_install_doctor_uninstall_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            env_root=Path(td)/'skills'
            install=subprocess.run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',str(ROOT/'install.ps1'),'-SkillsRoot',str(env_root)],capture_output=True,text=True)
            self.assertEqual(install.returncode,0,install.stderr)
            doctor=subprocess.run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',str(ROOT/'doctor.ps1'),'-SkillsRoot',str(env_root)],capture_output=True,text=True)
            self.assertEqual(doctor.returncode,0,doctor.stderr)
            uninstall=subprocess.run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',str(ROOT/'uninstall.ps1'),'-SkillsRoot',str(env_root)],capture_output=True,text=True)
            self.assertEqual(uninstall.returncode,0,uninstall.stderr)
            self.assertFalse((env_root/'youtube-voc-collector').exists())

if __name__ == '__main__': unittest.main()
