import os, unittest
from atriguide_ingestion import MAX_AI_INPUT_CHARACTERS, add_fieldguide_compatibility, build_skeleton, duplicate_result, find_existing_duplicate, merge_manual_override, production_writes_allowed, select_text, shadow_writes_allowed, validate_publishable, validate_record, writes_allowed

class FakeSnapshot:
    def __init__(self, record_id): self.id = record_id

class FakeQuery:
    def __init__(self, ids): self.ids = ids
    def where(self, *args): return self
    def limit(self, value): return self
    def stream(self): return [FakeSnapshot(value) for value in self.ids]

class PipelineTests(unittest.TestCase):
    def test_ifu(self):
        r = build_skeleton("1", "IFU-0331.A CryoA.pdf", "u", "Instructions for Use\nContraindications\nWarnings")
        self.assertEqual(r["documentType"], "ifu")
        self.assertEqual(r["website"]["subCategory"], "IFUs")
    def test_survival(self):
        r = build_skeleton("2", "study.pdf", "u", "Surgical ablation was associated with improved five-year survival and mortality")
        self.assertEqual((r["website"]["mainCategory"], r["website"]["subCategory"]), ("MAZE", "Survival Benefits"))
    def test_underscored_article_summary(self):
        r = build_skeleton("2a", "Concomitant_Surgical_Ablation_article_summary.pdf", "u", "stroke mentioned in body")
        self.assertEqual(r["documentType"], "article_summary")
        self.assertEqual(r["website"]["mainCategory"], "MAZE")
    def test_ablation_title_beats_incidental_laa(self):
        r = build_skeleton("2b", "Performing the left atrial ablation pattern without atriotomy.pdf", "u", "appendage stroke")
        self.assertEqual((r["website"]["mainCategory"], r["website"]["subCategory"]), ("MAZE", "Rhythm Outcomes"))
    def test_override_survives(self):
        new = build_skeleton("3", "x.pdf", "u", "research")
        old = {"website":{"mainCategory":"LAA","subCategory":"Outcomes and Safety","manualOverride":True}}
        self.assertTrue(merge_manual_override(new, old)["website"]["manualOverride"])
    def test_legacy_top_level_override_survives(self):
        new = build_skeleton("3a", "x.pdf", "u", "research")
        old = {"mainCategory":"LAA","subCategory":"Stroke Reduction","manualOverride":True}
        merged = merge_manual_override(new, old)
        self.assertEqual((merged["website"]["mainCategory"], merged["website"]["subCategory"]), ("LAA", "Stroke Reduction"))
    def test_fieldguide_compatibility_fields(self):
        record = build_skeleton("3b", "x.pdf", "u", "research")
        record.update({"citation":"Smith et al.","summary":"Summary","clinicalTags":["AF"],"searchTerms":["maze"]})
        add_fieldguide_compatibility(record)
        self.assertEqual(record["author"], "Smith et al.")
        self.assertEqual(record["url"], "u")
        self.assertIn("maze", record["searchProfile"])
    def test_writes_need_two_keys(self):
        os.environ.pop("ATRIGUIDE_ENABLE_PRODUCTION_WRITES", None)
        self.assertFalse(writes_allowed(True))
        os.environ["ATRIGUIDE_ENABLE_PRODUCTION_WRITES"] = "YES"
        self.assertTrue(writes_allowed(True))
    def test_shadow_and_production_acknowledgements_are_separate(self):
        os.environ.pop("ATRIGUIDE_ENABLE_SHADOW_WRITES", None)
        os.environ["ATRIGUIDE_ENABLE_PRODUCTION_WRITES"] = "YES"
        self.assertFalse(shadow_writes_allowed(True, True))
        self.assertFalse(production_writes_allowed(True, True))
        os.environ["ATRIGUIDE_ENABLE_SHADOW_WRITES"] = "YES"
        self.assertTrue(shadow_writes_allowed(True, True))
        self.assertFalse(production_writes_allowed(True, True))
    def test_schema_is_valid(self):
        validate_record(build_skeleton("4", "consensus.pdf", "u", "Clinical practice guideline and consensus statement"))
    def test_ifu_stops_before_bulgarian_translation(self):
        text = "INSTRUCTIONS FOR USE en\nEnglish warnings\nÐ˜ÐÐ¡Ð¢Ð Ð£ÐšÐ¦Ð˜Ð˜ Ð—Ð Ð£ÐŸÐžÐ¢Ð Ð•Ð‘Ð bg\nTranslated warnings"
        selected = select_text(text, "ifu")
        self.assertIn("English warnings", selected)
        self.assertNotIn("Translated warnings", selected)
    def test_guideline_targets_surgical_topics(self):
        text = "authors " * 2000 + "Surgical ablation recommendation text " + "appendix " * 2000
        selected = select_text(text, "guideline_consensus")
        self.assertIn("Surgical ablation recommendation", selected)
    def test_guideline_filename_beats_incidental_ifu_phrase(self):
        r = build_skeleton("4a", "ESC_2020_Guidelines.pdf", "u", "instructions for use of anticoagulation")
        self.assertEqual(r["documentType"], "guideline_consensus")
        self.assertEqual((r["website"]["mainCategory"], r["website"]["subCategory"]), ("MISC", "Helpful Documents"))
    def test_survival_in_research_body_overrides_broad_ablation_title(self):
        r = build_skeleton("4b", "Surgical-Ablation-Long-Term-Trial.pdf", "u", "Adjusted long-term survival hazard ratio")
        self.assertEqual((r["website"]["mainCategory"], r["website"]["subCategory"]), ("MAZE", "Survival Benefits"))
    def test_empty_record_cannot_publish(self):
        with self.assertRaises(ValueError):
            validate_publishable(build_skeleton("5", "study.pdf", "u", "Methods Results research"))
    def test_ai_selection_never_exceeds_hard_budget(self):
        selected = select_text("Results\n" + ("evidence " * 20000), "research_paper")
        self.assertLessEqual(len(selected), MAX_AI_INPUT_CHARACTERS)
    def test_existing_duplicate_excludes_same_record_rerun(self):
        self.assertEqual(find_existing_duplicate(FakeQuery(["same", "other"]), "hash", "same"), "other")
        self.assertIsNone(find_existing_duplicate(FakeQuery(["same"]), "hash", "same"))
    def test_duplicate_result_is_explicit_and_non_mutating(self):
        result = duplicate_result({"id":"drive-2", "name":"copy.pdf"}, "duplicate_in_batch", "hash", "drive-1")
        self.assertEqual(result["action"], "skipped_no_write_no_move")
        self.assertEqual(result["duplicateOf"], "drive-1")

if __name__ == "__main__": unittest.main()

